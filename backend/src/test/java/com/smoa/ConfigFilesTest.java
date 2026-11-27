package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.regex.Pattern;

import org.junit.jupiter.api.Test;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.PropertySource;
import org.springframework.core.io.ClassPathResource;

/** 프로파일별 yml 의 핵심 계약(비밀 값 없음, 드라이버·URL, OFF 문자열)을 파일 내용으로 확인한다. 어떤 DB 도 사용하지 않는다. */
class ConfigFilesTest {

    private static Object value(String file, String key) throws IOException {
        List<PropertySource<?>> sources = new YamlPropertySourceLoader().load(file, new ClassPathResource(file));
        for (PropertySource<?> source : sources) {
            Object raw = source.getProperty(key);
            if (raw != null) {
                return raw instanceof org.springframework.boot.origin.OriginTrackedValue tracked ? tracked.getValue() : raw;
            }
        }
        return null;
    }

    private static String text(String file) throws IOException {
        return new String(new ClassPathResource(file).getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    }

    @Test
    void local은_log4jdbc_DriverSpy와_환경변수_접속정보만_쓴다() throws Exception {
        String f = "application-local.yml";
        assertThat(value(f, "spring.datasource.driver-class-name")).isEqualTo("net.sf.log4jdbc.sql.jdbcapi.DriverSpy");
        assertThat(value(f, "spring.datasource.url"))
                .isEqualTo("jdbc:log4jdbc:mariadb://${SMOA_DB_HOST}:${SMOA_DB_PORT}/${SMOA_DB_NAME}");
        assertThat(value(f, "spring.datasource.username")).isEqualTo("${SMOA_DB_USER}");
        assertThat(value(f, "spring.datasource.password")).isEqualTo("${SMOA_DB_PASSWORD}");

        // YAML 에서 따옴표 없는 OFF 는 불리언 false 가 되므로 문자열이어야 한다.
        for (String name : new String[] {"sqlonly", "audit", "resultset", "resultsettable", "connection"}) {
            assertThat(value(f, "logging.level.jdbc." + name)).as(name).isInstanceOf(String.class).isEqualTo("OFF");
        }
        assertThat(value(f, "logging.level.jdbc.sqltiming")).isEqualTo("DEBUG");
        assertThat(value(f, "logging.level.com.zaxxer.hikari.HikariDataSource")).isEqualTo("ERROR");
    }

    @Test
    void prod는_일반_MariaDB_드라이버이며_sqltiming은_OFF() throws Exception {
        String f = "application-prod.yml";
        assertThat(value(f, "spring.datasource.driver-class-name")).isEqualTo("org.mariadb.jdbc.Driver");
        assertThat((String) value(f, "spring.datasource.url")).startsWith("jdbc:mariadb://").doesNotContain("log4jdbc");
        assertThat(value(f, "logging.level.jdbc.sqltiming")).isInstanceOf(String.class).isEqualTo("OFF");
        assertThat(value(f, "server.servlet.session.cookie.secure")).isEqualTo(true);
        assertThat(text(f)).doesNotContain("DriverSpy");
    }

    @Test
    void 공통_설정은_로깅_설정과_보안_쿠키_기본값을_가진다() throws Exception {
        String f = "application.yml";
        assertThat(value(f, "logging.config")).isEqualTo("classpath:log4j2.xml");
        assertThat(value(f, "server.servlet.session.cookie.secure")).isEqualTo(true);
        assertThat(value(f, "server.servlet.session.cookie.http-only")).isEqualTo(true);
        assertThat(value(f, "server.servlet.session.cookie.same-site")).isEqualTo("lax");
        assertThat(value(f, "server.servlet.session.timeout")).isEqualTo("30m");
        assertThat(value(f, "spring.sql.init.mode")).isEqualTo("never");
        assertThat(value(f, "spring.profiles.active")).as("기본 프로파일 자동 선택 금지").isNull();
        assertThat(value(f, "spring.datasource.url")).as("기본 설정에 DB 없음").isNull();
        assertThat(value(f, "mybatis.configuration.log-impl")).isEqualTo("org.apache.ibatis.logging.nologging.NoLoggingImpl");
        assertThat(value(f, "mybatis.configuration.shrink-whitespaces-in-sql")).as("SQL 공백 원본 보존").isEqualTo(false);
        assertThat(value(f, "spring.jackson.deserialization.fail-on-unknown-properties")).isEqualTo(true);
    }

    @Test
    void local_memory는_DataSource를_제외하고_Secure만_끈다() throws Exception {
        String f = "application-local-memory.yml";
        assertThat(value(f, "spring.datasource.url")).isNull();
        assertThat(value(f, "server.servlet.session.cookie.secure")).isEqualTo(false);
        assertThat(value(f, "server.address")).isEqualTo("127.0.0.1");
        assertThat(value(f, "smoa.bootstrap.username")).isEqualTo("${SMOA_BOOTSTRAP_USERNAME:}");
        assertThat(value(f, "smoa.bootstrap.password")).isEqualTo("${SMOA_BOOTSTRAP_PASSWORD:}");
        assertThat(text(f)).contains("DataSourceAutoConfiguration", "MybatisAutoConfiguration");
    }

    @Test
    void 설정_파일에_실제_IP나_비밀번호_리터럴이_없다() throws Exception {
        Pattern ip = Pattern.compile("\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b");
        for (String f : new String[] {"application.yml", "application-local.yml", "application-prod.yml",
                "application-local-memory.yml"}) {
            String content = text(f);
            // 허용: 바인딩 주소 127.0.0.1 하나만
            String withoutLoopback = content.replace("127.0.0.1", "");
            assertThat(ip.matcher(withoutLoopback).find()).as(f + " IP").isFalse();
            content.lines().filter(l -> l.stripLeading().startsWith("password:")).forEach(l -> assertThat(l)
                    .as(f + " password 는 환경 변수 참조만").containsPattern("\\$\\{[A-Z_]+(:)?\\}"));
        }
    }
}
