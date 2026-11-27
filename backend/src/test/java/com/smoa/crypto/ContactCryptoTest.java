package com.smoa.crypto;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.smoa.crypto.ContactCrypto.ContactCryptoException;
import com.smoa.crypto.ContactCrypto.Failure;

/**
 * Node(scripts/migrate-workspace.cjs seal) ↔ Java 봉투 호환. fixture 는 합성 키(0x00..0x1f)·합성 번호로
 * backend/src/test/resources/crypto/generate-contact-fixture.cjs 가 Node 로 만든 것이다(실제 키·연락처 아님).
 */
class ContactCryptoTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode fixture() throws Exception {
        try (InputStream in = ContactCryptoTest.class.getResourceAsStream("/crypto/contact-envelope-fixture.json")) {
            return JSON.readTree(in);
        }
    }

    private static ContactCrypto crypto(JsonNode fixture) {
        return new ContactCrypto(HexFormat.of().parseHex(fixture.get("keyHex").asText()));
    }

    @Test
    void Node가_봉인한_이관_봉투와_웹_봉투를_Java가_연다() throws Exception {
        JsonNode f = fixture();
        ContactCrypto crypto = crypto(f);
        String lib = f.get("library").asText();
        for (JsonNode c : f.get("cases")) {
            List<String> accepted = List.of(ContactVault.migratedAad(lib, "person-src-1"), ContactVault.newAad(lib, "42"));
            assertThat(crypto.open(c.get("envelope").asText(), accepted)).isEqualTo(c.get("phone").asText());
        }
    }

    @Test
    void 같은_키_iv_aad_이면_Java_봉투가_Node_봉투와_바이트까지_같다() throws Exception {
        JsonNode f = fixture();
        ContactCrypto crypto = crypto(f);
        JsonNode migrated = f.get("cases").get(0);
        byte[] iv = new byte[12];
        for (int i = 0; i < 12; i++) {
            iv[i] = (byte) (i + 1);
        }
        assertThat(crypto.seal(migrated.get("phone").asText(), migrated.get("aad").asText(), iv))
                .isEqualTo(migrated.get("envelope").asText());
        JsonNode web = f.get("cases").get(1);
        byte[] iv2 = new byte[12];
        for (int i = 0; i < 12; i++) {
            iv2[i] = (byte) (100 + i);
        }
        assertThat(crypto.seal(web.get("phone").asText(), web.get("aad").asText(), iv2)).isEqualTo(web.get("envelope").asText());
    }

    @Test
    void 평문은_따옴표가_있는_JSON_문자열이고_태그는_16바이트로_분리된다() throws Exception {
        JsonNode f = fixture();
        String envelope = crypto(f).seal("010-0000-1234", "SMOA:v1:lib:TGMSTR:db:1:PHONE_ENC");
        JsonNode e = JSON.readTree(envelope);
        assertThat(e.fieldNames()).toIterable().containsExactly("version", "keyVersion", "aad", "iv", "tag", "body");
        assertThat(e.get("version").asInt()).isEqualTo(1);
        assertThat(e.get("keyVersion").asText()).isEqualTo("v1");
        assertThat(Base64.getDecoder().decode(e.get("iv").asText())).hasSize(12);
        assertThat(Base64.getDecoder().decode(e.get("tag").asText())).hasSize(16);
        // 원시 JCE 로 직접 열어 본 평문: JSON.stringify("...") 이므로 따옴표를 포함한다(원문 UTF-8 을 바로 암호화하지 않는다)
        byte[] body = Base64.getDecoder().decode(e.get("body").asText());
        byte[] tag = Base64.getDecoder().decode(e.get("tag").asText());
        byte[] joined = new byte[body.length + 16];
        System.arraycopy(body, 0, joined, 0, body.length);
        System.arraycopy(tag, 0, joined, body.length, 16);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(HexFormat.of().parseHex(f.get("keyHex").asText()), "AES"),
                new GCMParameterSpec(128, Base64.getDecoder().decode(e.get("iv").asText())));
        cipher.updateAAD("SMOA:v1:lib:TGMSTR:db:1:PHONE_ENC".getBytes(StandardCharsets.UTF_8));
        assertThat(new String(cipher.doFinal(joined), StandardCharsets.UTF_8)).isEqualTo("\"010-0000-1234\"");
        assertThat(envelope).doesNotContain("010-0000-1234");
    }

    @Test
    void 봉투가_주장하는_AAD_를_믿지_않고_레코드_기준_기대값과_다르면_거부한다() throws Exception {
        JsonNode f = fixture();
        ContactCrypto crypto = crypto(f);
        String lib = f.get("library").asText();
        String envelope = f.get("cases").get(0).get("envelope").asText();   // person-src-1 의 봉투
        // 다른 레코드(다른 원본 ID/다른 TGT_ID)의 기대 AAD 만 주면 열리지 않는다
        assertThatThrownBy(() -> crypto.open(envelope, List.of(ContactVault.migratedAad(lib, "person-src-2"), ContactVault.newAad(lib, "1"))))
                .isInstanceOfSatisfying(ContactCryptoException.class, e -> assertThat(e.failure()).isEqualTo(Failure.AAD_MISMATCH));
        // 다른 자료실의 AAD
        assertThatThrownBy(() -> crypto.open(envelope, List.of(ContactVault.migratedAad("other-lib", "person-src-1"))))
                .isInstanceOf(ContactCryptoException.class);
    }

    @Test
    void 봉투의_AAD_문자열만_바꿔도_GCM_인증이_실패한다() throws Exception {
        JsonNode f = fixture();
        ContactCrypto crypto = crypto(f);
        String envelope = f.get("cases").get(0).get("envelope").asText();
        String forgedAad = "SMOA:v1:lib-synthetic:TGMSTR:person-src-X:PHONE_ENC";
        String forged = envelope.replace("person-src-1", "person-src-X");
        assertThatThrownBy(() -> crypto.open(forged, List.of(forgedAad)))
                .isInstanceOfSatisfying(ContactCryptoException.class, e -> assertThat(e.failure()).isEqualTo(Failure.AUTHENTICATION_FAILED));
    }

    @Test
    void 태그_본문_변조와_다른_키는_명시적으로_실패하고_원문을_돌려주지_않는다() throws Exception {
        JsonNode f = fixture();
        ContactCrypto crypto = crypto(f);
        String lib = f.get("library").asText();
        List<String> accepted = List.of(ContactVault.migratedAad(lib, "person-src-1"));
        ObjectNode tampered = (ObjectNode) JSON.readTree(f.get("cases").get(0).get("envelope").asText());
        byte[] tag = Base64.getDecoder().decode(tampered.get("tag").asText());
        tag[0] ^= 0x01;
        tampered.put("tag", Base64.getEncoder().encodeToString(tag));
        assertThatThrownBy(() -> crypto.open(JSON.writeValueAsString(tampered), accepted))
                .isInstanceOfSatisfying(ContactCryptoException.class, e -> assertThat(e.failure()).isEqualTo(Failure.AUTHENTICATION_FAILED));

        ObjectNode bodyTampered = (ObjectNode) JSON.readTree(f.get("cases").get(0).get("envelope").asText());
        byte[] body = Base64.getDecoder().decode(bodyTampered.get("body").asText());
        body[0] ^= 0x01;
        bodyTampered.put("body", Base64.getEncoder().encodeToString(body));
        assertThatThrownBy(() -> crypto.open(JSON.writeValueAsString(bodyTampered), accepted)).isInstanceOf(ContactCryptoException.class);

        ContactCrypto other = ContactCrypto.random();
        assertThatThrownBy(() -> other.open(f.get("cases").get(0).get("envelope").asText(), accepted))
                .isInstanceOfSatisfying(ContactCryptoException.class, e -> assertThat(e.failure()).isEqualTo(Failure.AUTHENTICATION_FAILED));
        // 오류 메시지에 원문·키가 없다
        assertThatThrownBy(() -> other.open(f.get("cases").get(0).get("envelope").asText(), accepted))
                .satisfies(e -> assertThat(e.getMessage()).doesNotContain("010").doesNotContain(f.get("keyHex").asText()));
    }

    @Test
    void 형식이_잘못된_봉투는_MALFORMED() throws Exception {
        ContactCrypto crypto = ContactCrypto.random();
        for (String bad : new String[] {"", "not json", "{}", "{\"version\":2}", "[]"}) {
            assertThatThrownBy(() -> crypto.open(bad, List.of("x"))).isInstanceOfSatisfying(ContactCryptoException.class,
                    e -> assertThat(e.failure()).isEqualTo(Failure.MALFORMED));
        }
    }

    @Test
    void 키_파일은_정확히_32바이트여야_하고_없거나_짧으면_명시_실패한다(@TempDir Path dir) throws Exception {
        Path good = dir.resolve("good.key");
        Files.write(good, new byte[32]);
        assertThat(ContactCrypto.fromKeyFile(good)).isNotNull();
        Path shortKey = dir.resolve("short.key");
        Files.write(shortKey, new byte[31]);
        assertThatThrownBy(() -> ContactCrypto.fromKeyFile(shortKey)).isInstanceOfSatisfying(ContactCryptoException.class,
                e -> assertThat(e.failure()).isEqualTo(Failure.KEY_UNAVAILABLE));
        Path longKey = dir.resolve("long.key");
        Files.write(longKey, new byte[33]);
        assertThatThrownBy(() -> ContactCrypto.fromKeyFile(longKey)).isInstanceOf(ContactCryptoException.class);
        assertThatThrownBy(() -> ContactCrypto.fromKeyFile(dir.resolve("missing.key"))).isInstanceOf(ContactCryptoException.class);
    }

    @Test
    void AAD_규칙은_이관_행과_웹_행이_다르다() {
        assertThat(ContactVault.migratedAad("L1", "src-9")).isEqualTo("SMOA:v1:L1:TGMSTR:src-9:PHONE_ENC");
        assertThat(ContactVault.newAad("L1", "77")).isEqualTo("SMOA:v1:L1:TGMSTR:db:77:PHONE_ENC");
    }

    @Test
    void 연락처_형식_검증과_끝_네_자리() {
        assertThat(ContactVault.digitsOf("010-1234-5678")).isEqualTo("01012345678");
        assertThatThrownBy(() -> ContactVault.digitsOf("12ab")).hasMessageNotContaining("12ab");
        assertThatThrownBy(() -> ContactVault.digitsOf("123456")).isInstanceOf(com.smoa.common.ApiException.class);
        assertThatThrownBy(() -> ContactVault.digitsOf("1".repeat(16))).isInstanceOf(com.smoa.common.ApiException.class);
        assertThat(new ContactVault.PhoneSecret("{secret}", "5678", "v1").toString()).doesNotContain("secret").doesNotContain("5678");
    }

}
