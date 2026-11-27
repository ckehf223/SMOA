package com.smoa.security;

import java.util.List;

import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

import com.smoa.access.AccessGrant;

/**
 * 요청마다 저장소에서 다시 계산한 최신 권한 스냅샷을 담는 인증 객체(세션에는 저장되지 않는다).
 * 권한·범위는 이 객체의 AccessGrant 기준으로만 판정한다. Authority 는 단순 인증 표시일 뿐 업무 권한이 아니다.
 */
public final class AccountAuthentication extends AbstractAuthenticationToken {

    private static final long serialVersionUID = 1L;

    private final transient AccessGrant grant;

    public AccountAuthentication(AccessGrant grant) {
        super(List.of(new SimpleGrantedAuthority("AUTHENTICATED")));
        this.grant = grant;
        setAuthenticated(true);
    }

    public AccessGrant grant() {
        return grant;
    }

    @Override
    public Object getCredentials() {
        return null;
    }

    @Override
    public Object getPrincipal() {
        return grant.account();
    }

    @Override
    public String getName() {
        return grant.accountId();
    }
}
