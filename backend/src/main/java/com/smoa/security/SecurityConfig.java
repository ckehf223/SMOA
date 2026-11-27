package com.smoa.security;

import java.time.Clock;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.AuthenticationEventPublisher;
import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.authentication.ProviderManager;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy;
import org.springframework.security.web.header.writers.StaticHeadersWriter;

import com.smoa.access.AccessService;
import com.smoa.account.AccountRepository;
import com.smoa.config.SmoaProperties;
import com.smoa.otp.OtpService;

import jakarta.servlet.http.HttpServletRequest;

/**
 * 세션 인증 + CSRF 보호. 로그인은 표준 formLogin 필터(POST /api/auth/login, application/x-www-form-urlencoded)를 쓰므로
 * 세션 고정 방어(changeSessionId)와 SecurityContext 저장을 프레임워크가 처리한다.
 * CORS 는 허용하지 않는다(동일 출처 전용). 기본은 모두 거부이고 아래 URL 만 연다.
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    PasswordEncoder passwordEncoder(SmoaProperties properties) {
        return new BCryptPasswordEncoder(properties.security().bcryptStrength());
    }

    @Bean
    LoginAttemptLimiter loginAttemptLimiter(SmoaProperties properties) {
        SmoaProperties.Security s = properties.security();
        return new LoginAttemptLimiter(s.loginMaxFailures(), s.loginWindow(), s.loginLockout(),
                s.loginTrackerMaxEntries(), Clock.systemUTC());
    }

    @Bean
    AuthenticationProvider authenticationProvider(AccountUserDetailsService userDetailsService,
            PasswordEncoder passwordEncoder, OtpService otp) {
        return new OtpAuthenticationProvider(userDetailsService, passwordEncoder, otp);
    }

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http, SmoaProperties properties,
            AuthenticationProvider authenticationProvider, JsonSecurityHandlers handlers,
            ProgramAuthorizationManagers managers, AccountRepository accounts, AccessService access,
            LoginAttemptLimiter limiter, OtpService otp, AuthenticationEventPublisher authenticationEvents,
            @Value("${smoa.security.protect-app-shell:false}") boolean protectAppShell,
            @Value("${server.servlet.session.cookie.name:JSESSIONID}") String sessionCookieName) throws Exception {

        String[] publicPaths = properties.security().publicPaths().toArray(String[]::new);
        boolean otpRequired = otp.required();
        boolean requireShellSession = protectAppShell || otpRequired;
        ProviderManager login = new ProviderManager(authenticationProvider);
        login.setAuthenticationEventPublisher(authenticationEvents);

        http
                .authenticationManager(login)
                .cors(AbstractHttpConfigurer::disable)
                .httpBasic(AbstractHttpConfigurer::disable)
                .requestCache(cache -> cache.disable())
                // 토큰은 /api/auth/csrf 로 JSON 전달하고 X-CSRF-TOKEN 헤더로 돌려받는다. 로그인·로그아웃 시 프레임워크가 폐기한다.
                .csrf(csrf -> csrf.csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler()))
                .sessionManagement(session -> session.sessionFixation(fixation -> fixation.changeSessionId()))
                .exceptionHandling(ex -> ex.authenticationEntryPoint((request, response, error) -> {
                    if (requireShellSession && isBrowserEntry(request)) {
                        response.sendRedirect(request.getContextPath() + "/login.html");
                    } else {
                        handlers.commence(request, response, error);
                    }
                }).accessDeniedHandler(handlers))
                .formLogin(form -> form
                        .loginPage(LoginThrottleFilter.LOGIN_PATH)
                        .loginProcessingUrl(LoginThrottleFilter.LOGIN_PATH)
                        .usernameParameter("username")
                        .passwordParameter("password")
                        .authenticationDetailsSource(OtpAuthenticationProvider::details)
                        .successHandler(handlers)
                        .failureHandler(handlers))
                .logout(logout -> logout
                        .logoutUrl("/api/auth/logout")
                        .logoutSuccessHandler(handlers)
                        .invalidateHttpSession(true)
                        .clearAuthentication(true)
                        .deleteCookies(sessionCookieName))
                .headers(headers -> {
                    headers.contentSecurityPolicy(csp -> csp.policyDirectives(
                            "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"))
                            .referrerPolicy(referrer -> referrer.policy(ReferrerPolicy.NO_REFERRER))
                            .frameOptions(frame -> frame.deny());
                    if (requireShellSession) {
                        headers.addHeaderWriter(new StaticHeadersWriter("X-Robots-Tag", "noindex, nofollow"));
                    }
                })
                .authorizeHttpRequests(auth -> {
                    auth.requestMatchers(HttpMethod.GET, "/api/auth/csrf", "/api/auth/otp-policy").permitAll();
                    auth.requestMatchers(HttpMethod.POST, LoginThrottleFilter.LOGIN_PATH, "/api/auth/logout").permitAll();
                    auth.requestMatchers(HttpMethod.GET, "/api/auth/me").authenticated();
                    if (requireShellSession) {
                        auth.requestMatchers("/", "/index.html").authenticated();
                        auth.requestMatchers(HttpMethod.GET, "/login.html").permitAll();
                    }
                    auth.requestMatchers("/error").permitAll();
                    auth.requestMatchers("/api/admin/**").access(managers.superAdmin());
                    auth.requestMatchers("/pages/**").access(managers.pages());
                    auth.requestMatchers("/api/programs/**").access(managers.programApi());
                    if (publicPaths.length > 0) {
                        auth.requestMatchers(HttpMethod.GET, publicPaths).permitAll();
                    }
                    auth.anyRequest().denyAll();
                })
                .addFilterBefore(new LoginThrottleFilter(limiter, handlers), UsernamePasswordAuthenticationFilter.class)
                .addFilterBefore(new AccountStateFilter(accounts, access, otpRequired), AuthorizationFilter.class);
        return http.build();
    }

    private static boolean isBrowserEntry(HttpServletRequest request) {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        String accept = request.getHeader("Accept");
        return HttpMethod.GET.matches(request.getMethod()) && ("/".equals(path) || "/index.html".equals(path))
                && accept != null && accept.contains(MediaType.TEXT_HTML_VALUE);
    }
}
