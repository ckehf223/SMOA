package com.smoa.crypto;

import java.nio.file.Path;
import java.util.List;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import com.smoa.bootstrap.StorageProfileGuard;
import com.smoa.common.ApiException;
import com.smoa.config.SmoaProperties;
import com.smoa.crypto.ContactCrypto.ContactCryptoException;

/**
 * 연락처 암호화 경계. 키는 환경 변수 SMOA_CONTACT_KEY_FILE 이 가리키는 32바이트 파일에서만 오며 값·내용은 기록하지 않는다.
 * <ul>
 *   <li>local/prod: 키가 설정되었는데 읽을 수 없거나 32바이트가 아니면 기동 실패. 설정되지 않았으면 기동은 되지만
 *       연락처 쓰기는 503 CONTACT_KEY_UNAVAILABLE 으로 명시 실패한다(끝 네 자리 조회는 키 없이 가능).</li>
 *   <li>local-memory: 키 파일이 없으면 프로세스 수명 동안만 쓰는 임의 키를 만든다(가상 자료 전용).</li>
 * </ul>
 * 연락처 원문·암호문은 어떤 API 응답·로그·변경 이력에도 넣지 않는다. 이 클래스는 봉인(쓰기)과 레코드 기준 AAD 계산만 제공한다.
 */
@Component
public class ContactVault {

    /** 전화번호: 숫자·공백·하이픈·괄호·선행 +, 숫자 7~15자리. */
    private static final Pattern PHONE_CHARS = Pattern.compile("\\+?[0-9 ()-]{7,30}");

    private static final Logger log = LoggerFactory.getLogger(ContactVault.class);

    /** 저장할 연락처 값(봉투 JSON + 끝 네 자리 + 키 버전). 봉투는 toString 에 포함하지 않는다. */
    public record PhoneSecret(String envelope, String last4, String keyVersion) {
        @Override
        public String toString() {
            return "PhoneSecret[last4=****]";
        }
    }

    private final ContactCrypto crypto;
    private final boolean ephemeral;

    public ContactVault(SmoaProperties properties, Environment environment) {
        String keyFile = properties.contact().keyFile();
        boolean memory = List.of(environment.getActiveProfiles()).contains(StorageProfileGuard.LOCAL_MEMORY);
        if (keyFile != null && !keyFile.isBlank()) {
            try {
                this.crypto = ContactCrypto.fromKeyFile(Path.of(keyFile.strip()));
            } catch (ContactCryptoException e) {
                throw new IllegalStateException(e.getMessage());
            } catch (RuntimeException e) {
                throw new IllegalStateException("SMOA_CONTACT_KEY_FILE 경로가 올바르지 않습니다.");
            }
            this.ephemeral = false;
        } else if (memory) {
            this.crypto = ContactCrypto.random();
            this.ephemeral = true;
            log.warn("[local-memory] 연락처 암호화 키 파일이 없어 이 프로세스에서만 쓰는 임의 키를 만들었습니다(가상 자료 전용).");
        } else {
            this.crypto = null;
            this.ephemeral = false;
            log.warn("SMOA_CONTACT_KEY_FILE 이 설정되지 않아 연락처 저장·수정은 사용할 수 없습니다(끝 네 자리 조회는 가능).");
        }
    }

    public boolean available() {
        return crypto != null;
    }

    public boolean ephemeralKey() {
        return ephemeral;
    }

    /** 키가 없으면 503. */
    private ContactCrypto require() {
        if (crypto == null) {
            throw new ApiException(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE, "CONTACT_KEY_UNAVAILABLE",
                    "연락처 암호화 키가 설정되지 않아 연락처를 저장할 수 없습니다. 관리자에게 문의하세요.");
        }
        return crypto;
    }

    /** 입력을 검증하고(숫자 7~15자리) 봉인한다. aad 는 레코드로부터 계산한 값. 오류 메시지에 입력값을 넣지 않는다. */
    public PhoneSecret seal(String phone, String aad) {
        String digits = digitsOf(phone);
        ContactCrypto c = require();
        try {
            return new PhoneSecret(c.seal(phone.strip(), aad), digits.substring(digits.length() - 4),
                    ContactCrypto.KEY_VERSION);
        } catch (ContactCryptoException e) {
            throw new ApiException(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE, "CONTACT_SEAL_FAILED",
                    "연락처를 저장하지 못했습니다.");
        }
    }

    /** 검증용 열기(운영 API 에는 노출하지 않는다). 레코드 기준 기대 AAD 목록만 받는다. */
    public String openForVerification(String envelope, List<String> acceptedAads) {
        return require().open(envelope, acceptedAads);
    }

    public static String digitsOf(String phone) {
        if (phone == null || !PHONE_CHARS.matcher(phone.strip()).matches()) {
            throw ApiException.badRequest("INVALID_PHONE", "연락처 형식이 올바르지 않습니다(숫자 7~15자리).");
        }
        String digits = phone.replaceAll("\\D", "");
        if (digits.length() < 7 || digits.length() > 15) {
            throw ApiException.badRequest("INVALID_PHONE", "연락처 형식이 올바르지 않습니다(숫자 7~15자리).");
        }
        return digits;
    }

    /** 이관(마이그레이션) 행 AAD: SOURCE_ID 는 MIGMAP(ENTITY_KIND=TGMSTR, TARGET_ID)에 대응하는 원본 ID. */
    public static String migratedAad(String libraryId, String sourceId) {
        return "SMOA:v1:" + libraryId + ":TGMSTR:" + sourceId + ":PHONE_ENC";
    }

    /** 웹에서 만든 행(또는 웹에서 연락처를 다시 봉인한 행) AAD: AUTO_INCREMENT 로 확정된 TGT_ID 사용. */
    public static String newAad(String libraryId, String targetId) {
        return "SMOA:v1:" + libraryId + ":TGMSTR:db:" + targetId + ":PHONE_ENC";
    }
}
