package com.smoa.security;

import java.util.Optional;

import org.springframework.security.authentication.AuthenticationCredentialsNotFoundException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

import com.smoa.access.AccessGrant;

/** 현재 요청의 최신 권한 스냅샷. 컨트롤러/서비스는 클라이언트가 보낸 계정·패키지·범위가 아니라 이 값만 사용한다. */
public final class CurrentAccount {

    private CurrentAccount() {
    }

    public static Optional<AccessGrant> find() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication instanceof AccountAuthentication a) {
            return Optional.of(a.grant());
        }
        return Optional.empty();
    }

    /** 인증되지 않았으면 401 처리되도록 예외를 던진다. */
    public static AccessGrant require() {
        return find().orElseThrow(() -> new AuthenticationCredentialsNotFoundException("not authenticated"));
    }
}
