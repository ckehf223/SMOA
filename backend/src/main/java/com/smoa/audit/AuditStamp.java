package com.smoa.audit;

import java.time.LocalDateTime;
import java.time.ZoneOffset;

import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import com.smoa.security.CurrentAccount;

/**
 * 서버가 채우는 SYS_* 감사 값. 처리자·IP 는 요청 컨텍스트에서만 가져오며 클라이언트 입력은 쓰지 않는다.
 * 감사 시각({@code utcNow})은 UTC 이고, 업무 시각(적용일시 등)은 Asia/Seoul 이다. 둘을 섞지 않는다.
 * 요청 밖(부트스트랩 등)에서는 userId=SYSTEM, ip=127.0.0.1 이다.
 */
public record AuditStamp(String userId, String userName, String ip, LocalDateTime utcNow) {

    public static final String SYSTEM = "SYSTEM";

    public static AuditStamp current() {
        String id = SYSTEM;
        String name = SYSTEM;
        var grant = CurrentAccount.find();
        if (grant.isPresent()) {
            id = cut(grant.get().accountId(), 50);
            name = cut(grant.get().account().displayName(), 100);
        }
        String ip = "127.0.0.1";
        RequestAttributes attributes = RequestContextHolder.getRequestAttributes();
        if (attributes instanceof ServletRequestAttributes servlet && servlet.getRequest().getRemoteAddr() != null) {
            ip = cut(servlet.getRequest().getRemoteAddr(), 50);
        }
        return new AuditStamp(id, name, ip, LocalDateTime.now(ZoneOffset.UTC).withNano(0));
    }

    public static AuditStamp system() {
        return new AuditStamp(SYSTEM, SYSTEM, "127.0.0.1", LocalDateTime.now(ZoneOffset.UTC).withNano(0));
    }

    private static String cut(String value, int max) {
        return value == null ? "" : value.length() > max ? value.substring(0, max) : value;
    }
}
