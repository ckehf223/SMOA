package com.smoa.otp;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.Arrays;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Pattern;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.smoa.crypto.ContactCrypto;
import com.smoa.otp.OtpRegistry.Entry;

@Service
public final class OtpService {
    private static final Pattern OTP = Pattern.compile("[0-9]{6}");
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String REQUIRED = "OTP_REQUIRED";
    private static final String INVALID = "OTP_INVALID";
    private static final String NOT_ENROLLED = "OTP_NOT_ENROLLED";

    private final boolean required;
    private final Clock clock;
    private final OtpRegistry registry;

    @Autowired
    public OtpService(
            @Value("${smoa.otp.required:${SMOA_OTP_REQUIRED:false}}") boolean required,
            @Value("${smoa.otp.state-file:${SMOA_OTP_STATE_FILE:}}") String stateFile,
            @Value("${smoa.otp.key-file:${SMOA_OTP_KEY_FILE:}}") String keyFile,
            @Value("${smoa.otp.bootstrap-file:${SMOA_OTP_BOOTSTRAP_FILE:}}") String bootstrapFile) {
        this(required, stateFile, keyFile, bootstrapFile, Clock.systemUTC());
    }

    OtpService(boolean required, String stateFile, String keyFile, String bootstrapFile, Clock clock) {
        this.required = required;
        this.clock = clock;
        this.registry = required ? initialize(stateFile, keyFile, bootstrapFile) : null;
    }

    public boolean required() {
        return required;
    }

    public boolean enrolled(String accountId) {
        return required && access(entries -> {
            Entry entry = entries.get(accountId);
            return entry != null && entry.enrolled();
        });
    }

    /** An existing verified key is never returned or replaced by provisioning. */
    public String provision(String accountId) {
        if (!required || accountId == null || accountId.isBlank() || accountId.length() > 100) {
            throw new OtpAuthenticationException(INVALID);
        }
        return access(entries -> {
            Entry existing = entries.get(accountId);
            if (existing != null) {
                if (existing.enrolled()) {
                    throw new OtpAuthenticationException(INVALID);
                }
                return existing.secret();
            }
            byte[] secret = new byte[20];
            try {
                RANDOM.nextBytes(secret);
                String encoded = Totp.encode(secret);
                entries.put(accountId, new Entry(encoded, -1, false));
                return encoded;
            } finally {
                Arrays.fill(secret, (byte) 0);
            }
        });
    }

    public void verify(String accountId, String code) {
        if (!required) {
            return;
        }
        if (code == null || code.isBlank()) {
            throw new OtpAuthenticationException(REQUIRED);
        }
        if (!OTP.matcher(code).matches()) {
            throw new OtpAuthenticationException(INVALID);
        }
        access(entries -> {
            Entry existing = entries.get(accountId);
            if (existing == null) {
                throw new OtpAuthenticationException(NOT_ENROLLED);
            }
            long step = Math.floorDiv(clock.instant().getEpochSecond(), Totp.PERIOD_SECONDS);
            long matched = -1;
            byte[] supplied = code.getBytes(StandardCharsets.US_ASCII);
            byte[] secret = Totp.decode(existing.secret());
            try {
                for (long candidate = step - 1; candidate <= step + 1; candidate++) {
                    if (candidate >= 0 && MessageDigest.isEqual(supplied,
                            Totp.code(secret, candidate, 6).getBytes(StandardCharsets.US_ASCII))) {
                        matched = candidate;
                    }
                }
            } finally {
                Arrays.fill(secret, (byte) 0);
            }
            if (matched <= existing.lastStep()) {
                throw new OtpAuthenticationException(INVALID);
            }
            entries.put(accountId, new Entry(existing.secret(), matched, true));
            return null;
        });
    }

    private <T> T access(Function<Map<String, Entry>, T> operation) {
        try {
            return registry.access(operation);
        } catch (OtpAuthenticationException e) {
            throw e;
        } catch (IOException | RuntimeException e) {
            throw new OtpAuthenticationException(INVALID);
        }
    }

    private static OtpRegistry initialize(String stateFile, String keyFile, String bootstrapFile) {
        if (stateFile.isBlank() || keyFile.isBlank()) {
            throw new IllegalStateException("OTP를 사용하려면 저장소와 암호화 키 파일을 설정해야 합니다.");
        }
        try {
            Path state = Path.of(stateFile).toAbsolutePath().normalize();
            Path key = Path.of(keyFile).toAbsolutePath().normalize();
            Path bootstrap = bootstrapFile.isBlank() ? null : Path.of(bootstrapFile).toAbsolutePath().normalize();
            if (state.equals(key) || state.resolveSibling(state.getFileName() + ".lock").equals(key)
                    || state.equals(bootstrap) || state.resolveSibling(state.getFileName() + ".lock").equals(bootstrap)) {
                throw new IllegalArgumentException("OTP 파일 경로는 서로 달라야 합니다.");
            }
            OtpRegistry registry = new OtpRegistry(state, ContactCrypto.fromKeyFile(key));
            registry.initialize(bootstrap == null ? Map.of() : seed(bootstrap));
            return registry;
        } catch (IOException | RuntimeException e) {
            throw new IllegalStateException("OTP 저장소 또는 초기 설정을 읽을 수 없습니다.");
        }
    }

    private record BootstrapAccount(String accountId, String secret) {}

    private static Map<String, Entry> seed(Path bootstrapFile) throws IOException {
        if (Files.size(bootstrapFile) > 4096) {
            throw new IOException("OTP 초기 설정 크기가 올바르지 않습니다.");
        }
        BootstrapAccount entry = JSON.readValue(Files.readString(bootstrapFile), BootstrapAccount.class);
        String accountId = entry.accountId();
        if (accountId == null || accountId.isBlank() || accountId.length() > 100 || entry.secret() == null) {
            throw new IllegalArgumentException("OTP 초기 설정 형식이 올바르지 않습니다.");
        }
        byte[] bytes = Totp.decode(entry.secret());
        try {
            return Map.of(accountId, new Entry(Totp.encode(bytes), -1, true));
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }
}
