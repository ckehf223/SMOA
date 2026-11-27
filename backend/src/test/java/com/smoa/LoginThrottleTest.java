package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import org.junit.jupiter.api.Test;

import com.smoa.account.Account;
import com.smoa.security.LoginAttemptLimiter;
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

class LoginThrottleTest extends ApiTestBase {

    @Test
    void 연속_실패하면_올바른_비밀번호도_잠시_429로_거절된다() throws Exception {
        Account account = createAccount(createPackage("p", java.util.Map.of(), org()));
        TestClient attacker = client();
        for (int i = 0; i < 5; i++) {
            attacker.login(account.username(), "Wrong-" + i + PASSWORD).andExpect(status().isUnauthorized());
        }
        attacker.login(account.username(), PASSWORD).andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.code").value("LOGIN_LOCKED"));
        // 존재하지 않는 계정도 같은 제한을 받는다(존재 여부를 알려 주지 않는다)
        TestClient other = client();
        for (int i = 0; i < 5; i++) {
            other.login("ghost-" + account.username(), "Wrong-" + i + PASSWORD).andExpect(status().isUnauthorized());
        }
        other.login("ghost-" + account.username(), PASSWORD).andExpect(status().isTooManyRequests());
        // 다른 IP 의 정상 사용자는 영향이 없다
        client().login(account.username(), PASSWORD).andExpect(status().isOk());
    }

    @Test
    void 성공하면_실패_횟수가_초기화된다() throws Exception {
        Account account = createAccount(createPackage("p", java.util.Map.of(), org()));
        TestClient client = client();
        for (int i = 0; i < 4; i++) {
            client.login(account.username(), "Wrong-" + i + PASSWORD).andExpect(status().isUnauthorized());
        }
        client.login(account.username(), PASSWORD).andExpect(status().isOk());
        client.logout();
        for (int i = 0; i < 4; i++) {
            client.login(account.username(), "Wrong-" + i + PASSWORD).andExpect(status().isUnauthorized());
        }
        client.login(account.username(), PASSWORD).andExpect(status().isOk());
    }

    /** 시계를 직접 움직이는 단위 검증: 만료·메모리 상한. */
    static final class MutableClock extends Clock {
        Instant now = Instant.parse("2026-01-01T00:00:00Z");

        @Override
        public java.time.ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }

    @Test
    void 잠금은_시간이_지나면_풀린다() {
        MutableClock clock = new MutableClock();
        LoginAttemptLimiter limiter = new LoginAttemptLimiter(3, Duration.ofMinutes(15), Duration.ofMinutes(15), 100, clock);
        for (int i = 0; i < 3; i++) {
            limiter.recordFailure("1.1.1.1", "kim");
        }
        assertThat(limiter.isLocked("1.1.1.1", "kim")).isTrue();
        assertThat(limiter.isLocked("1.1.1.1", "lee")).isFalse();
        clock.now = clock.now.plus(Duration.ofMinutes(16));
        assertThat(limiter.isLocked("1.1.1.1", "kim")).isFalse();
    }

    @Test
    void 추적_항목은_상한을_넘어_쌓이지_않는다() {
        MutableClock clock = new MutableClock();
        LoginAttemptLimiter limiter = new LoginAttemptLimiter(5, Duration.ofMinutes(15), Duration.ofMinutes(15), 50, clock);
        for (int i = 0; i < 10_000; i++) {
            limiter.recordFailure("9.9.9." + (i % 250), "user" + i);
        }
        assertThat(limiter.size()).isLessThanOrEqualTo(50);
    }

    @Test
    void 한_IP가_여러_계정을_시도해도_IP_단위로_잠긴다() {
        MutableClock clock = new MutableClock();
        LoginAttemptLimiter limiter = new LoginAttemptLimiter(2, Duration.ofMinutes(15), Duration.ofMinutes(15), 1000, clock);
        // IP 단독 한도 = 2 * 6 = 12
        for (int i = 0; i < 12; i++) {
            limiter.recordFailure("5.5.5.5", "name" + i);
        }
        assertThat(limiter.isLocked("5.5.5.5", "someone-new")).isTrue();
        assertThat(limiter.isLocked("6.6.6.6", "someone-new")).isFalse();
    }
}
