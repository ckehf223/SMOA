package com.smoa.security;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.security.web.authentication.AuthenticationFailureHandler;
import org.springframework.security.web.authentication.AuthenticationSuccessHandler;
import org.springframework.security.web.authentication.logout.LogoutSuccessHandler;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.smoa.access.AccessService;
import com.smoa.account.Account;
import com.smoa.account.AccountRepository;
import com.smoa.common.ApiError;
import com.smoa.otp.OtpAuthenticationException;
import com.smoa.web.AccessViews;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * 인증·인가 결과의 JSON 응답. 401(미인증) / 403(권한 없음·CSRF 실패) / 로그인 성공·실패 / 로그아웃.
 * 비밀번호 인증 실패는 계정 존재·비활성 여부와 무관하게 같은 응답이다.
 */
@Component
public class JsonSecurityHandlers implements AuthenticationEntryPoint, AccessDeniedHandler,
        AuthenticationSuccessHandler, AuthenticationFailureHandler, LogoutSuccessHandler {

    private final ObjectMapper objectMapper;
    private final AccountRepository accounts;
    private final AccessService access;
    private final AccessViews views;
    private final LoginAttemptLimiter limiter;

    public JsonSecurityHandlers(ObjectMapper objectMapper, AccountRepository accounts, AccessService access,
            AccessViews views, LoginAttemptLimiter limiter) {
        this.objectMapper = objectMapper;
        this.accounts = accounts;
        this.access = access;
        this.views = views;
        this.limiter = limiter;
    }

    @Override
    public void commence(HttpServletRequest request, HttpServletResponse response, AuthenticationException ex)
            throws IOException {
        write(response, HttpStatus.UNAUTHORIZED, ApiError.of("UNAUTHENTICATED", "로그인이 필요합니다."));
    }

    @Override
    public void handle(HttpServletRequest request, HttpServletResponse response, AccessDeniedException ex)
            throws IOException {
        write(response, HttpStatus.FORBIDDEN, ApiError.of("FORBIDDEN", "접근 권한이 없거나 요청을 검증하지 못했습니다."));
    }

    @Override
    public void onAuthenticationSuccess(HttpServletRequest request, HttpServletResponse response,
            Authentication authentication) throws IOException {
        limiter.recordSuccess(request.getRemoteAddr(), LoginThrottleFilter.normalizedUsername(request));
        Account account = accounts.findById(((SmoaUserDetails) authentication.getPrincipal()).accountId())
                .orElseThrow(() -> new IllegalStateException("로그인한 계정을 찾을 수 없습니다."));
        write(response, HttpStatus.OK, views.me(access.resolve(account)));
    }

    @Override
    public void onAuthenticationFailure(HttpServletRequest request, HttpServletResponse response,
            AuthenticationException exception) throws IOException {
        limiter.recordFailure(request.getRemoteAddr(), LoginThrottleFilter.normalizedUsername(request));
        if (exception instanceof OtpAuthenticationException otpFailure) {
            String code = otpFailure.code();
            String message = switch (code) {
                case "OTP_REQUIRED" -> "인증 앱의 6자리 코드를 입력하세요.";
                case "OTP_NOT_ENROLLED" -> "OTP가 아직 등록되지 않았습니다. 관리자에게 문의하세요.";
                default -> "인증 코드가 올바르지 않거나 이미 사용되었습니다. 새 코드를 확인하세요.";
            };
            write(response, HttpStatus.UNAUTHORIZED, ApiError.of(code, message));
            return;
        }
        write(response, HttpStatus.UNAUTHORIZED,
                ApiError.of("LOGIN_FAILED", "로그인 ID 또는 비밀번호가 올바르지 않습니다."));
    }

    public void writeLocked(HttpServletResponse response) throws IOException {
        response.setHeader("Retry-After", "900");
        write(response, HttpStatus.TOO_MANY_REQUESTS,
                ApiError.of("LOGIN_LOCKED", "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요."));
    }

    @Override
    public void onLogoutSuccess(HttpServletRequest request, HttpServletResponse response,
            Authentication authentication) throws IOException {
        write(response, HttpStatus.OK, java.util.Map.of("status", "logged-out"));
    }

    private void write(HttpServletResponse response, HttpStatus status, Object body) throws IOException {
        response.setStatus(status.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        objectMapper.writeValue(response.getOutputStream(), body);
    }
}
