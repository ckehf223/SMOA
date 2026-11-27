package com.smoa.web;

import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.smoa.security.CurrentAccount;
import com.smoa.otp.OtpService;
import com.smoa.web.dto.Views.MeResponse;

/**
 * 로그인(POST /api/auth/login)과 로그아웃(POST /api/auth/logout)은 Spring Security 필터가 처리한다.
 * 여기에는 CSRF 토큰 발급, OTP 정책과 현재 사용자 조회가 있다.
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AccessViews views;
    private final OtpService otp;

    public AuthController(AccessViews views, OtpService otp) {
        this.views = views;
        this.otp = otp;
    }

    public record CsrfResponse(String headerName, String parameterName, String token) {
    }

    public record OtpPolicyResponse(boolean required) {
    }

    /** 로그인 전·후, 로그아웃 후마다 새 토큰을 받아 변경 요청 헤더로 보낸다. */
    @GetMapping("/csrf")
    public CsrfResponse csrf(CsrfToken token) {
        return new CsrfResponse(token.getHeaderName(), token.getParameterName(), token.getToken());
    }

    @GetMapping("/otp-policy")
    public OtpPolicyResponse otpPolicy() {
        return new OtpPolicyResponse(otp.required());
    }

    @GetMapping("/me")
    public MeResponse me() {
        return views.me(CurrentAccount.require());
    }
}
