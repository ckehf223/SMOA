package com.smoa.security;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 로그인 실패 제한. 키는 (IP+정규화 로그인 ID) 와 (IP 단독) 두 가지이며 계정 존재 여부와 무관하게 동작한다.
 * 메모리는 maxEntries 로 제한한다: 한도를 넘으면 만료된 항목부터 지우고, 그래도 넘으면 가장 오래 쓰이지 않은 항목을 지운다.
 * 단일 인스턴스 메모리 기반이다(재시작 시 초기화).
 */
public final class LoginAttemptLimiter {

    /** IP 단독 키의 한도 배율. */
    static final int IP_MULTIPLIER = 6;

    private record Entry(int failures, Instant windowStart, Instant lockedUntil) {
    }

    private final int maxFailures;
    private final Duration window;
    private final Duration lockout;
    private final int maxEntries;
    private final Clock clock;
    private final LinkedHashMap<String, Entry> entries = new LinkedHashMap<>(64, 0.75f, true);

    public LoginAttemptLimiter(int maxFailures, Duration window, Duration lockout, int maxEntries, Clock clock) {
        if (maxFailures < 1 || maxEntries < 2) {
            throw new IllegalArgumentException("로그인 제한 설정이 올바르지 않습니다.");
        }
        this.maxFailures = maxFailures;
        this.window = window;
        this.lockout = lockout;
        this.maxEntries = maxEntries;
        this.clock = clock;
    }

    public static String userKey(String ip, String normalizedUsername) {
        return "u|" + ip + "|" + normalizedUsername;
    }

    public static String ipKey(String ip) {
        return "i|" + ip;
    }

    public synchronized boolean isLocked(String ip, String normalizedUsername) {
        Instant now = clock.instant();
        return lockedNow(userKey(ip, normalizedUsername), now) || lockedNow(ipKey(ip), now);
    }

    public synchronized void recordFailure(String ip, String normalizedUsername) {
        Instant now = clock.instant();
        record(userKey(ip, normalizedUsername), maxFailures, now);
        record(ipKey(ip), maxFailures * IP_MULTIPLIER, now);
        enforceBound(now);
    }

    /** 성공하면 (IP+ID) 키만 초기화한다. IP 단독 카운터는 시간 만료로만 풀린다. */
    public synchronized void recordSuccess(String ip, String normalizedUsername) {
        entries.remove(userKey(ip, normalizedUsername));
    }

    public synchronized int size() {
        return entries.size();
    }

    private boolean lockedNow(String key, Instant now) {
        Entry e = entries.get(key);
        return e != null && e.lockedUntil() != null && now.isBefore(e.lockedUntil());
    }

    private void record(String key, int limit, Instant now) {
        Entry e = entries.get(key);
        if (e == null || expired(e, now)) {
            e = new Entry(0, now, null);
        }
        int failures = e.failures() + 1;
        Instant lockedUntil = e.lockedUntil();
        if (failures >= limit) {
            lockedUntil = now.plus(lockout);
        }
        entries.put(key, new Entry(failures, e.windowStart(), lockedUntil));
    }

    private boolean expired(Entry e, Instant now) {
        if (e.lockedUntil() != null) {
            return !now.isBefore(e.lockedUntil());
        }
        return !now.isBefore(e.windowStart().plus(window));
    }

    private void enforceBound(Instant now) {
        if (entries.size() <= maxEntries) {
            return;
        }
        for (Iterator<Map.Entry<String, Entry>> it = entries.entrySet().iterator(); it.hasNext();) {
            if (expired(it.next().getValue(), now)) {
                it.remove();
            }
        }
        Iterator<String> eldest = entries.keySet().iterator();
        while (entries.size() > maxEntries && eldest.hasNext()) {
            eldest.next();
            eldest.remove();
        }
    }
}
