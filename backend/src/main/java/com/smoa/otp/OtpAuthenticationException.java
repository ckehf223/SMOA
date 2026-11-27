package com.smoa.otp;

import org.springframework.security.core.AuthenticationException;

public final class OtpAuthenticationException extends AuthenticationException {
    private final String code;

    public OtpAuthenticationException(String code) {
        super("인증 코드를 확인해 주세요.");
        this.code = code;
    }

    public String code() {
        return code;
    }
}
