package com.smoa.security;

import java.util.Collection;
import java.util.List;

import org.springframework.security.core.CredentialsContainer;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

/**
 * 로그인 시점에 세션에 저장되는 최소 principal. 권한·범위·패키지는 담지 않고(요청마다 저장소에서 다시 읽는다)
 * 계정 ID, credentialVersion, OTP 검증 여부를 가진다. 인증 직후 비밀번호 해시는 지워진다({@link CredentialsContainer}).
 */
public final class SmoaUserDetails implements UserDetails, CredentialsContainer {

    private static final long serialVersionUID = 1L;

    private final String accountId;
    private final String username;
    private final long credentialVersion;
    private String password;
    private boolean otpVerified;

    public SmoaUserDetails(String accountId, String username, String passwordHash, long credentialVersion) {
        this.accountId = accountId;
        this.username = username;
        this.password = passwordHash;
        this.credentialVersion = credentialVersion;
    }

    public String accountId() {
        return accountId;
    }

    public long credentialVersion() {
        return credentialVersion;
    }

    boolean otpVerified() {
        return otpVerified;
    }

    void markOtpVerified() {
        otpVerified = true;
    }

    @Override
    public Collection<? extends GrantedAuthority> getAuthorities() {
        return List.of(new SimpleGrantedAuthority("AUTHENTICATED"));
    }

    @Override
    public String getPassword() {
        return password;
    }

    @Override
    public String getUsername() {
        return username;
    }

    @Override
    public void eraseCredentials() {
        this.password = null;
    }

    @Override
    public String toString() {
        return "SmoaUserDetails[accountId=" + accountId + "]";
    }
}
