package com.smoa.crypto;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * 연락처 AES-256-GCM 봉투. {@code scripts/migrate-workspace.cjs} 의 seal()/open() 과 정확히 호환된다.
 * <pre>
 *   평문   : JSON.stringify(value)  — 전화번호 문자열을 따옴표 포함 JSON 문자열로 직렬화한 UTF-8 바이트(원문 UTF-8 을 바로 암호화하지 않는다)
 *   봉투   : {"version":1,"keyVersion":"v1","aad":"...","iv":b64(12),"tag":b64(16),"body":b64(암호문)}  (키 순서 고정, 공백 없음)
 *   AAD    : 봉투에 적힌 값과 호출자가 레코드로부터 계산한 기대값이 같아야 하며 GCM 인증에도 쓰인다
 * </pre>
 * 키는 정확히 32바이트인 파일에서만 읽는다. 키·평문·봉투는 로그·예외 메시지에 넣지 않는다.
 * 키가 틀리거나 AAD/태그/본문이 변조되면 {@link ContactCryptoException} 으로 명시 실패하며 원문을 보여 주거나 대체하지 않는다.
 */
public final class ContactCrypto {

    public static final int KEY_LENGTH = 32;
    public static final String KEY_VERSION = "v1";
    private static final int IV_LENGTH = 12;
    private static final int TAG_BYTES = 16;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SecureRandom RANDOM = new SecureRandom();

    public enum Failure {
        KEY_UNAVAILABLE, MALFORMED, AAD_MISMATCH, AUTHENTICATION_FAILED
    }

    public static final class ContactCryptoException extends RuntimeException {
        private final Failure failure;

        public ContactCryptoException(Failure failure, String message) {
            super(message);
            this.failure = failure;
        }

        public Failure failure() {
            return failure;
        }
    }

    private final SecretKeySpec key;

    public ContactCrypto(byte[] keyBytes) {
        if (keyBytes == null || keyBytes.length != KEY_LENGTH) {
            throw new ContactCryptoException(Failure.KEY_UNAVAILABLE, "연락처 암호화 키는 정확히 " + KEY_LENGTH + "바이트여야 합니다.");
        }
        this.key = new SecretKeySpec(keyBytes.clone(), "AES");
    }

    /** 32바이트 원시 키 파일을 읽는다. 내용은 어디에도 남기지 않는다. */
    public static ContactCrypto fromKeyFile(Path path) {
        byte[] bytes;
        try {
            bytes = Files.readAllBytes(path);
        } catch (IOException | RuntimeException e) {
            throw new ContactCryptoException(Failure.KEY_UNAVAILABLE, "연락처 암호화 키 파일을 읽을 수 없습니다(SMOA_CONTACT_KEY_FILE).");
        }
        try {
            return new ContactCrypto(bytes);
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    public static ContactCrypto random() {
        byte[] bytes = new byte[KEY_LENGTH];
        RANDOM.nextBytes(bytes);
        try {
            return new ContactCrypto(bytes);
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    /** value 를 JSON.stringify 와 같은 문자열로 직렬화해 AES-256-GCM 으로 봉인하고 봉투 JSON 텍스트를 돌려준다. */
    public String seal(String value, String aad) {
        byte[] iv = new byte[IV_LENGTH];
        RANDOM.nextBytes(iv);
        return seal(value, aad, iv);
    }

    /** 테스트용 결정적 iv 지원(같은 키·iv 재사용 금지: 운영 코드는 {@link #seal(String, String)} 만 쓴다). */
    String seal(String value, String aad, byte[] iv) {
        try {
            byte[] plain = JSON.writeValueAsString(value).getBytes(StandardCharsets.UTF_8);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BYTES * 8, iv));
            cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            byte[] out = cipher.doFinal(plain);                       // 암호문 || 태그(16)
            byte[] body = Arrays.copyOfRange(out, 0, out.length - TAG_BYTES);
            byte[] tag = Arrays.copyOfRange(out, out.length - TAG_BYTES, out.length);
            Map<String, Object> envelope = new LinkedHashMap<>();    // Node JSON.stringify 와 같은 키 순서
            envelope.put("version", 1);
            envelope.put("keyVersion", KEY_VERSION);
            envelope.put("aad", aad);
            envelope.put("iv", Base64.getEncoder().encodeToString(iv));
            envelope.put("tag", Base64.getEncoder().encodeToString(tag));
            envelope.put("body", Base64.getEncoder().encodeToString(body));
            return JSON.writeValueAsString(envelope);
        } catch (GeneralSecurityException | JsonProcessingException e) {
            throw new ContactCryptoException(Failure.MALFORMED, "연락처 봉인에 실패했습니다.");
        }
    }

    /**
     * 봉투를 열어 원문 문자열을 돌려준다. 봉투가 주장하는 AAD 를 믿지 않고, 호출자가 레코드로 계산한
     * {@code acceptedAads}(예: 이관 AAD, 신규 AAD) 중 하나와 정확히 같을 때만 그 값으로 GCM 인증한다.
     */
    public String open(String envelopeJson, Collection<String> acceptedAads) {
        JsonNode node;
        try {
            node = JSON.readTree(envelopeJson);
        } catch (JsonProcessingException | RuntimeException e) {
            throw new ContactCryptoException(Failure.MALFORMED, "연락처 봉투 형식이 올바르지 않습니다.");
        }
        if (node == null || !node.isObject() || node.path("version").asInt(-1) != 1 || !node.path("aad").isTextual()
                || !node.path("iv").isTextual() || !node.path("tag").isTextual() || !node.path("body").isTextual()) {
            throw new ContactCryptoException(Failure.MALFORMED, "연락처 봉투 형식이 올바르지 않습니다.");
        }
        String claimed = node.get("aad").asText();
        byte[] claimedBytes = claimed.getBytes(StandardCharsets.UTF_8);
        String expected = null;
        for (String candidate : acceptedAads) {
            if (MessageDigest.isEqual(claimedBytes, candidate.getBytes(StandardCharsets.UTF_8))) {
                expected = candidate;
                break;
            }
        }
        if (expected == null) {
            throw new ContactCryptoException(Failure.AAD_MISMATCH, "연락처 봉투의 AAD 가 레코드의 기대값과 다릅니다.");
        }
        try {
            byte[] iv = Base64.getDecoder().decode(node.get("iv").asText());
            byte[] tag = Base64.getDecoder().decode(node.get("tag").asText());
            byte[] body = Base64.getDecoder().decode(node.get("body").asText());
            if (iv.length != IV_LENGTH || tag.length != TAG_BYTES) {
                throw new ContactCryptoException(Failure.MALFORMED, "연락처 봉투 형식이 올바르지 않습니다.");
            }
            byte[] joined = new byte[body.length + tag.length];
            System.arraycopy(body, 0, joined, 0, body.length);
            System.arraycopy(tag, 0, joined, body.length, tag.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BYTES * 8, iv));
            cipher.updateAAD(expected.getBytes(StandardCharsets.UTF_8));
            byte[] plain = cipher.doFinal(joined);
            JsonNode value = JSON.readTree(new String(plain, StandardCharsets.UTF_8));
            if (value == null || !value.isTextual()) {
                throw new ContactCryptoException(Failure.MALFORMED, "연락처 봉투 내용 형식이 올바르지 않습니다.");
            }
            return value.asText();
        } catch (ContactCryptoException e) {
            throw e;
        } catch (IllegalArgumentException | JsonProcessingException e) {
            throw new ContactCryptoException(Failure.MALFORMED, "연락처 봉투 형식이 올바르지 않습니다.");
        } catch (GeneralSecurityException e) {
            throw new ContactCryptoException(Failure.AUTHENTICATION_FAILED, "연락처 봉투 인증에 실패했습니다(키·AAD·본문 확인).");
        }
    }
}
