package com.smoa.otp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class OtpServiceTest {
    private static final byte[] RFC_SECRET = "12345678901234567890".getBytes(StandardCharsets.US_ASCII);

    @TempDir
    Path directory;

    @Test
    void matchesRfc6238Sha1Vectors() {
        long[] timestamps = {59L, 1_111_111_109L, 1_111_111_111L, 1_234_567_890L, 2_000_000_000L, 20_000_000_000L};
        String[] expected = {"94287082", "07081804", "14050471", "89005924", "69279037", "65353130"};
        byte[] decoded = Totp.decode(Totp.encode(RFC_SECRET));
        assertThat(decoded).isEqualTo(RFC_SECRET);
        for (int i = 0; i < timestamps.length; i++) {
            assertThat(Totp.code(decoded, timestamps[i] / 30, 8)).isEqualTo(expected[i]);
        }
    }

    @Test
    void provisionIsPendingUntilFirstValidCodeAndReplayPersistsAcrossInstances() throws Exception {
        Path state = directory.resolve("private/otp.state");
        Path key = keyFile();
        OtpService service = service(state, key, "", 59);
        assertThat(service.required()).isTrue();
        assertThat(service.enrolled("member")).isFalse();
        assertCode(() -> service.verify("member", "123456"), "OTP_NOT_ENROLLED");
        String secret = service.provision("member");
        assertThat(service.provision("member")).isEqualTo(secret);
        assertThat(service.enrolled("member")).isFalse();
        assertThat(Files.readString(state)).doesNotContain(secret, "member");
        assertCode(() -> service.verify("member", ""), "OTP_REQUIRED");
        assertCode(() -> service.verify("member", "1234x6"), "OTP_INVALID");

        byte[] decoded = Totp.decode(secret);
        String code = Totp.code(decoded, 1, 6);
        service.verify("member", code);
        assertThat(service.enrolled("member")).isTrue();
        assertCode(() -> service.provision("member"), "OTP_INVALID");
        OtpService restarted = service(state, key, "", 59);
        assertThat(restarted.enrolled("member")).isTrue();
        assertCode(() -> restarted.verify("member", code), "OTP_INVALID");
        service(state, key, "", 120).verify("member", Totp.code(decoded, 4, 6));
    }

    @Test
    void concurrentServicesCannotAcceptTheSameCode() throws Exception {
        Path state = directory.resolve("otp.state");
        Path key = keyFile();
        OtpService first = service(state, key, "", 59);
        OtpService second = service(state, key, "", 59);
        String code = Totp.code(Totp.decode(first.provision("same-member")), 1, 6);
        try (var pool = Executors.newFixedThreadPool(2)) {
            Callable<Boolean> login1 = () -> attempt(first, code);
            Callable<Boolean> login2 = () -> attempt(second, code);
            var outcomes = pool.invokeAll(List.of(login1, login2));
            assertThat(List.of(outcomes.get(0).get(), outcomes.get(1).get())).containsExactlyInAnyOrder(true, false);
        }
    }

    @Test
    void bootstrapDoesNotReplaceAnExistingKeyAndMissingInitializedStateFailsClosed() throws Exception {
        Path state = directory.resolve("otp.state");
        Path key = keyFile();
        Path seed = Files.writeString(directory.resolve("seed.json"), """
                {"accountId":"admin","secret":"%s"}
                """.formatted(Totp.encode(RFC_SECRET)));
        OtpService original = service(state, key, seed.toString(), 60);
        assertThat(original.enrolled("admin")).isTrue();
        original.verify("admin", Totp.code(RFC_SECRET, 1, 6));

        Files.writeString(seed, """
                {"accountId":"admin","secret":"%s"}
                """.formatted(Totp.encode(new byte[20])));
        OtpService restarted = service(state, key, seed.toString(), 60);
        restarted.verify("admin", Totp.code(RFC_SECRET, 2, 6));

        Files.delete(state);
        assertCode(() -> original.verify("admin", Totp.code(RFC_SECRET, 3, 6)), "OTP_INVALID");
        assertThatThrownBy(() -> service(state, key, seed.toString(), 60))
                .isInstanceOf(IllegalStateException.class);
    }

    private boolean attempt(OtpService service, String code) {
        try {
            service.verify("same-member", code);
            return true;
        } catch (OtpAuthenticationException e) {
            assertThat(e.code()).isEqualTo("OTP_INVALID");
            return false;
        }
    }

    private Path keyFile() throws Exception {
        return Files.write(directory.resolve("otp.key"), new byte[32]);
    }

    private static OtpService service(Path state, Path key, String bootstrap, long epochSeconds) {
        return new OtpService(true, state.toString(), key.toString(), bootstrap,
                Clock.fixed(Instant.ofEpochSecond(epochSeconds), ZoneOffset.UTC));
    }

    private static void assertCode(Runnable operation, String code) {
        assertThatThrownBy(operation::run).isInstanceOfSatisfying(OtpAuthenticationException.class,
                error -> assertThat(error.code()).isEqualTo(code));
    }
}
