package com.smoa.account;

import java.util.Locale;
import java.util.Objects;

/**
 * 계정 도메인. 권한은 계정이 아니라 packageId 가 가리키는 권한 패키지에서만 온다(계정에 직접 권한·범위·직책 없음).
 * passwordHash 는 BCrypt 해시이며 어떤 응답·로그에도 포함하지 않는다(toString 에서도 제외).
 * credentialVersion 은 비밀번호 초기화·비활성화 때 올라가며, 이미 로그인한 세션은 값이 다르면 무효가 된다.
 */
public record Account(
        String id,
        String username,
        String displayName,
        String packageId,
        String passwordHash,
        boolean active,
        long credentialVersion) {

    public Account {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(username, "username");
        Objects.requireNonNull(displayName, "displayName");
        Objects.requireNonNull(packageId, "packageId");
        Objects.requireNonNull(passwordHash, "passwordHash");
    }

    public static String usernameKey(String username) {
        return username.trim().toLowerCase(Locale.ROOT);
    }

    public String usernameKey() {
        return usernameKey(username);
    }

    public Account withDisplayName(String value) {
        return new Account(id, username, value, packageId, passwordHash, active, credentialVersion);
    }

    public Account withActive(boolean value) {
        return new Account(id, username, displayName, packageId, passwordHash, value, credentialVersion);
    }

    public Account withPackageId(String value) {
        return new Account(id, username, displayName, value, passwordHash, active, credentialVersion);
    }

    public Account withPassword(String newHash) {
        return new Account(id, username, displayName, packageId, newHash, active, credentialVersion + 1);
    }

    /** 세션 무효화만 필요할 때(비활성화 등). */
    public Account withBumpedCredentialVersion() {
        return new Account(id, username, displayName, packageId, passwordHash, active, credentialVersion + 1);
    }

    @Override
    public String toString() {
        return "Account[id=" + id + ", packageId=" + packageId + ", active=" + active + "]";
    }
}
