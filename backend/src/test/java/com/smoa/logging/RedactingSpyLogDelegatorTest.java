package com.smoa.logging;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Configurator;
import org.apache.logging.log4j.core.config.Property;
import org.junit.jupiter.api.Test;

import net.sf.log4jdbc.log.SpyLogFactory;
import net.sf.log4jdbc.sql.jdbcapi.ConnectionSpy;

/** 민감 업무 테이블 SQL 은 값을 모두 가리고 일반 SQL 의 바인딩·공백·시간은 그대로 둔다. 실제 DB 없이 Mockito JDBC 위에서 실제 log4jdbc/Log4j2 이벤트로 검증한다. */
class RedactingSpyLogDelegatorTest {

    @Test
    void 연락처_암호문_INSERT_UPDATE_는_리터럴이_가려진다() {
        String insert = "INSERT INTO TGMSTR (TGT_NAME_HAN, PHONE_ENC, PHONE_LAST4)\n VALUES ('가상인', '{\"body\":\"c2VjcmV0\"}', '5678')";
        String red = RedactingSpyLogDelegator.redact(insert);
        assertThat(red).doesNotContain("c2VjcmV0").doesNotContain("5678").doesNotContain("가상인");
        assertThat(red).contains("INSERT INTO TGMSTR (TGT_NAME_HAN, PHONE_ENC, PHONE_LAST4)\n VALUES ('[REDACTED]', '[REDACTED]', '[REDACTED]')");
        String update = "UPDATE TGMSTR T SET T.PHONE_ENC = 'abc', T.PHONE_LAST4 = '1111' WHERE T.TGT_ID = 5";
        assertThat(RedactingSpyLogDelegator.redact(update)).doesNotContain("abc").doesNotContain("1111").contains("WHERE T.TGT_ID = 5");
    }

    @Test
    void 끝네자리_비교_조건과_비밀번호_해시_쓰기와_원본암호문도_가려진다() {
        String select = "SELECT T.TGT_ID FROM TGMSTR T WHERE T.LIB_ID = 'L1' AND T.PHONE_LAST4 = '7777'";
        assertThat(RedactingSpyLogDelegator.redact(select)).doesNotContain("7777");
        String user = "INSERT INTO USERMSTR (USER_ID, PASSWORD_HASH) VALUES ('u1', '$2a$04$abcdefghijklmnopqrstuv')";
        assertThat(RedactingSpyLogDelegator.redact(user)).doesNotContain("$2a$").doesNotContain("u1");
        assertThat(RedactingSpyLogDelegator.redact("UPDATE X SET SOURCE_ENC = 'zzz'")).doesNotContain("zzz");
        assertThat(RedactingSpyLogDelegator.redact("UPDATE X SET PHONE_ENC = 'a\\'b-secret', NOTES = 'it''s-secret2'"))
                .doesNotContain("secret").doesNotContain("secret2");
    }

    @Test
    void 민감_업무테이블_SQL은_컬럼과_상관없이_문자열_리터럴이_모두_가려진다() {
        // 검토에서 실증된 가상 SQL 3개
        assertThat(RedactingSpyLogDelegator.redact("UPDATE TGMSTR SET TGT_NAME_HAN='SYNTHETIC_NAME',NOTES='SYNTHETIC_NOTE' WHERE TGT_ID=1"))
                .isEqualTo("UPDATE TGMSTR SET TGT_NAME_HAN='[REDACTED]',NOTES='[REDACTED]' WHERE TGT_ID=1");
        assertThat(RedactingSpyLogDelegator.redact("SELECT TGT_ID FROM TGMSTR WHERE TGT_NAME_HAN LIKE '%SYNTHETIC_SEARCH%'"))
                .isEqualTo("SELECT TGT_ID FROM TGMSTR WHERE TGT_NAME_HAN LIKE '[REDACTED]'");
        assertThat(RedactingSpyLogDelegator.redact("UPDATE TGMSTR SET PHONE_ENC='SYNTHETIC_CIPHER' WHERE TGT_ID=1"))
                .isEqualTo("UPDATE TGMSTR SET PHONE_ENC='[REDACTED]' WHERE TGT_ID=1");
    }

    @Test
    void 대소문자_백틱_스키마접두어_멀티라인_주석_CTE_숫자값_이스케이프도_우회되지_않는다() {
        String sql = "/* SECRETA */ WITH cte AS (\n  SELECT * FROM `smoa`.`tgmstr` t -- SECRETB\n"
                + "  WHERE t.tgt_name_han = 'it''s SECRETC' OR t.notes = \"x\\\"SECRETD\"\n)\n"
                + "SELECT * FROM cte c\n  JOIN smoa.callmstr m ON m.phone = 5551234\n WHERE c.phone_last4 = 9876543210 # SECRETE\n"
                + "   AND c.x = x'53454352455446' AND c.y = 0x5345 AND c.z = 12.5e3 AND c.TGT_ID = 77 LIMIT 20 OFFSET 40";
        String red = RedactingSpyLogDelegator.redact(sql);
        for (String s : new String[] {"SECRETA", "SECRETB", "SECRETC", "SECRETD", "SECRETE", "9876543210", "5551234", "53454352455446", "0x5345", "12.5e3"}) {
            assertThat(red).doesNotContain(s);
        }
        // 레이아웃·컬럼·식별자·ID 숫자·LIMIT 은 남는다
        assertThat(red).contains("WITH cte AS (\n  SELECT * FROM `smoa`.`tgmstr` t -- [REDACTED]\n  WHERE t.tgt_name_han = '[REDACTED]'")
                .contains("JOIN smoa.callmstr m ON m.phone = [REDACTED]\n").contains("c.TGT_ID = 77 LIMIT 20 OFFSET 40");
        assertThat(RedactingSpyLogDelegator.redact("SELECT * FROM TGMSTR WHERE a = 'SECRETG")).doesNotContain("SECRETG");
        assertThat(RedactingSpyLogDelegator.redact("SELECT 1 FROM PSMSTR WHERE EMPL_ID = 123456")).doesNotContain("123456");
        assertThat(RedactingSpyLogDelegator.redact("SELECT 1 FROM USERMSTR WHERE LOGIN_ID = 'Admin' AND LIB_ID = 7")).doesNotContain("Admin");
    }

    @Test
    void 컬럼_이름만이_아니라_테이블로도_민감_판정한다() {
        assertThat(RedactingSpyLogDelegator.redact("INSERT INTO ACTMSTR (MEMO) VALUES ('SECRETM')")).doesNotContain("SECRETM");
        assertThat(RedactingSpyLogDelegator.redact("SELECT * FROM chglog WHERE AFTER_JSON LIKE '%SECRETN%'")).doesNotContain("SECRETN");
        assertThat(RedactingSpyLogDelegator.redact("UPDATE OTHERTBL SET PHONE_LAST4='SECRETO'")).doesNotContain("SECRETO");
        String other = "SELECT 1 FROM TGMSTR_VIEW_X WHERE a = 'visible'";
        assertThat(RedactingSpyLogDelegator.redact(other)).isEqualTo(other);
    }

    @Test
    void 비민감_일반_조회는_바인딩_값_공백_들여쓰기가_그대로다() {
        String select = "SELECT C.CODE_ID,\n       C.CODE_NAME\n  FROM CODEDTL C\n WHERE C.LIB_ID = 'LIB-1'\n   AND C.CODE_NAME LIKE '%가상%'  \n";
        assertThat(RedactingSpyLogDelegator.redact(select)).isEqualTo(select);
        assertThat(RedactingSpyLogDelegator.redact(null)).isNull();
        assertThat(RedactingSpyLogDelegator.redact("")).isEmpty();
    }

    @Test
    void 예외_정제는_메시지_원인_methodCall_인자를_남기지_않는다() {
        SQLException driver = new SQLException("Duplicate entry 'SECRET_DUP' for key 'UK'", "23000", 1062,
                new RuntimeException("cause SECRET_CAUSE"));
        Exception safe = RedactingSpyLogDelegator.sanitize(driver);
        assertThat(safe).isInstanceOf(SQLException.class);
        assertThat(safe.getCause()).isNull();
        assertThat(safe.getMessage()).doesNotContain("SECRET");
        assertThat(((SQLException) safe).getSQLState()).isEqualTo("23000");
        assertThat(((SQLException) safe).getErrorCode()).isEqualTo(1062);
        assertThat(RedactingSpyLogDelegator.safeMethod("setString(1, SECRET_ARG)")).isEqualTo("setString(...)");
        assertThat(RedactingSpyLogDelegator.safeMethod("executeQuery(SELECT 'SECRET_SQL')")).doesNotContain("SECRET");
    }

    /** 이벤트 메시지와 예외 체인을 통째로 캡처한다. */
    static final class Capture extends AbstractAppender {
        final List<String> messages = new CopyOnWriteArrayList<>();

        Capture() {
            super("redact-capture", null, null, true, Property.EMPTY_ARRAY);
        }

        @Override
        public void append(LogEvent event) {
            StringBuilder b = new StringBuilder(event.getLoggerName()).append('|').append(event.getMessage().getFormattedMessage());
            for (Throwable t = event.getThrown(); t != null; t = t.getCause()) {
                b.append("\nTHROWN ").append(t).append(' ').append(t.getMessage());
                for (Throwable s : t.getSuppressed()) {
                    b.append("\nSUPPRESSED ").append(s);
                }
            }
            messages.add(b.toString());
        }
    }

    private static final String[] LOGGERS = {"jdbc.sqltiming", "jdbc.sqlonly", "jdbc.audit", "jdbc.resultset", "jdbc.resultsettable", "jdbc.connection"};

    @Test
    void 실제_로그_이벤트에는_개인값_암호봉투_BCrypt_해시가_SQL_예외_어디에도_남지_않는다() throws Exception {
        Capture capture = new Capture();
        capture.start();
        List<org.apache.logging.log4j.core.Logger> attached = new ArrayList<>();
        for (String name : LOGGERS) { // 최악의 경우를 보려고 모든 log4jdbc 로거를 DEBUG 로 연다
            var lg = (org.apache.logging.log4j.core.Logger) LogManager.getLogger(name);
            lg.addAppender(capture);
            attached.add(lg);
            Configurator.setLevel(name, Level.DEBUG);
        }
        try {
            assertThat(SpyLogFactory.getSpyLogDelegator()).isInstanceOf(RedactingSpyLogDelegator.class);
            String envelope = "{\"version\":1,\"keyVersion\":\"v1\",\"aad\":\"VIRT-AAD\",\"iv\":\"VIRTIV\",\"tag\":\"VIRTTAG\",\"body\":\"VIRTBODY\"}";
            String bcrypt = "$2a$10$VIRTUALBCRYPTHASHVIRTUALBCRYPTHASHVIRTUALBCRYPTHAS";
            String updName = "UPDATE TGMSTR SET TGT_NAME_HAN = ?, NOTES = ?, PHONE_ENC = ? WHERE TGT_ID = ?";
            String search = "SELECT TGT_ID FROM TGMSTR WHERE TGT_NAME_HAN LIKE ?";
            String user = "UPDATE USERMSTR SET PASSWORD_HASH = ?, LOGIN_ID = ? WHERE USER_ID = ?";
            String plain = "SELECT CODE_NAME FROM CODEDTL WHERE CODE_NAME = ?";
            Connection delegate = mock(Connection.class);
            DatabaseMetaData metaData = mock(DatabaseMetaData.class);
            when(metaData.getDriverName()).thenReturn("virtual-driver");
            when(delegate.getMetaData()).thenReturn(metaData);
            PreparedStatement failing = mock(PreparedStatement.class);
            when(failing.executeUpdate()).thenThrow(new SQLException(
                    "Duplicate entry 'VIRTUAL_PERSON_NAME' for key 'UK_X'; Data too long 'VIRTUAL_NOTE_TEXT' " + envelope, "23000", 1062,
                    new RuntimeException("root cause VIRTUAL_CAUSE_VALUE")));
            when(delegate.prepareStatement(updName)).thenReturn(failing);
            PreparedStatement searchSt = mock(PreparedStatement.class);
            when(searchSt.executeQuery()).thenReturn(mock(java.sql.ResultSet.class));
            when(delegate.prepareStatement(search)).thenReturn(searchSt);
            when(delegate.prepareStatement(user)).thenReturn(mock(PreparedStatement.class));
            when(delegate.prepareStatement(plain)).thenReturn(mock(PreparedStatement.class));
            Connection spy = new ConnectionSpy(delegate, SpyLogFactory.getSpyLogDelegator());

            try (PreparedStatement p = spy.prepareStatement(updName)) {
                p.setString(1, "VIRTUAL_PERSON_NAME");
                p.setString(2, "VIRTUAL_NOTE_TEXT");
                p.setString(3, envelope);
                p.setLong(4, 9L);
                assertThatThrownBy(p::executeUpdate).isInstanceOf(SQLException.class);
            }
            try (PreparedStatement p = spy.prepareStatement(search)) {
                p.setString(1, "%VIRTUAL_SEARCH_NAME%");
                p.executeQuery();
            }
            try (PreparedStatement p = spy.prepareStatement(user)) {
                p.setString(1, bcrypt);
                p.setString(2, "VIRTUAL_LOGIN_NAME");
                p.setLong(3, 3L);
                p.executeUpdate();
            }
            try (PreparedStatement p = spy.prepareStatement(plain)) {
                p.setString(1, "일반코드명");
                p.execute();
            }
            String all = String.join("\n", capture.messages);
            assertThat(all).doesNotContain("VIRTUAL_PERSON_NAME").doesNotContain("VIRTUAL_NOTE_TEXT").doesNotContain("VIRTBODY")
                    .doesNotContain("VIRT-AAD").doesNotContain("VIRTIV").doesNotContain("VIRTTAG").doesNotContain("VIRTUAL_SEARCH_NAME")
                    .doesNotContain("VIRTUAL_CAUSE_VALUE").doesNotContain("VIRTUAL_LOGIN_NAME").doesNotContain("VIRTUALBCRYPT")
                    .doesNotContain("$2a$");
            // 로그는 실제로 남아 있다(빈 캡처로 통과하지 않는다)
            assertThat(all).contains("TGT_NAME_HAN LIKE '[REDACTED]'").contains("PASSWORD_HASH = '[REDACTED]'")
                    .contains("WHERE TGT_ID = 9").containsPattern("\\{executed in \\d+ msec\\}");
            assertThat(all).contains("FAILED").contains("details withheld");
            // 비민감 SQL 은 바인딩 값이 그대로 보인다
            assertThat(all).contains("CODE_NAME = '일반코드명'");
        } finally {
            for (var lg : attached) {
                lg.removeAppender(capture);
            }
            capture.stop();
            for (String name : LOGGERS) {
                Configurator.setLevel(name, Level.INFO);
            }
        }
    }
}
