package com.smoa.security;

import java.io.IOException;

import org.springframework.http.HttpMethod;
import org.springframework.web.filter.OncePerRequestFilter;

import com.smoa.account.Account;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/** 로그인 요청이 제한에 걸렸으면 인증을 시도하기 전에 429 로 거절한다(CSRF 검사 이후, 로그인 필터 이전). */
public final class LoginThrottleFilter extends OncePerRequestFilter {

    static final String LOGIN_PATH = "/api/auth/login";

    private final LoginAttemptLimiter limiter;
    private final JsonSecurityHandlers handlers;

    public LoginThrottleFilter(LoginAttemptLimiter limiter, JsonSecurityHandlers handlers) {
        this.limiter = limiter;
        this.handlers = handlers;
    }

    static String normalizedUsername(HttpServletRequest request) {
        String raw = request.getParameter("username");
        return raw == null ? "" : Account.usernameKey(raw);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        return !(HttpMethod.POST.matches(request.getMethod()) && LOGIN_PATH.equals(path));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (limiter.isLocked(request.getRemoteAddr(), normalizedUsername(request))) {
            handlers.writeLocked(response);
            return;
        }
        chain.doFilter(request, response);
    }
}
