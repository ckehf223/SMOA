package com.smoa.account.persistence;

import java.time.LocalDateTime;

/** USERMSTR 행. passwordHash 는 toString 에 포함하지 않는다(필드 노출 없음). */
public class AccountRow {
    public String id;
    public String username;
    public String usernameKey;
    public String displayName;
    public String packageId;
    public String passwordHash;
    public Boolean active;
    public Long credentialVersion;
    /** 서버가 채우는 감사 값(SYS_*). 조회 때는 쓰지 않는다. */
    public String sysUserId;
    public String sysIp;
    public LocalDateTime sysAt;

    @Override
    public String toString() {
        return "AccountRow[id=" + id + ", packageId=" + packageId + ", active=" + active + "]";
    }
}
