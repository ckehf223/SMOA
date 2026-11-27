package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Configurator;
import org.apache.logging.log4j.core.config.Property;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import net.sf.log4jdbc.sql.jdbcapi.ConnectionSpy;
import net.sf.log4jdbc.log.SpyLogFactory;
import net.sf.log4jdbc.log.slf4j.Slf4jSpyLogDelegator;
import net.sf.log4jdbc.Properties;

/**
 * 실제 DB 없이 검증한다: JDBC 객체는 Mockito 가상 구현이고, 실제 log4jdbc ConnectionSpy/PreparedStatementSpy 가 이를 감싼다.
 * 출력은 log4jdbc → SLF4J → Log4j2 의 jdbc.sqltiming 로거를 통과한 실제 로그 이벤트를 캡처해 확인한다.
 * 가상 SQL·가상 값만 사용하며 어떤 연결도 열지 않는다. (화면 조회→MariaDB SQL 로그 확인은 사용자 테이블·DB 연결 후 사용자 단계)
 */
class Log4jdbcSqlLoggingTest {

    static final class Capture extends AbstractAppender {
        final List<String> messages = new CopyOnWriteArrayList<>();

        Capture() {
            super("sqltiming-capture", null, null, true, Property.EMPTY_ARRAY);
        }

        @Override
        public void append(LogEvent event) {
            messages.add(event.getMessage().getFormattedMessage());
        }
    }

    private final Capture capture = new Capture();
    private org.apache.logging.log4j.core.Logger sqlTiming;

    @BeforeEach
    void attach() {
        capture.start();
        sqlTiming = (org.apache.logging.log4j.core.Logger) LogManager.getLogger("jdbc.sqltiming");
        sqlTiming.addAppender(capture);
        Configurator.setLevel("jdbc.sqltiming", Level.DEBUG); // application-local.yml 의 jdbc.sqltiming: DEBUG 와 같은 상태
    }

    @AfterEach
    void detach() {
        sqlTiming.removeAppender(capture);
        capture.stop();
        Configurator.setLevel("jdbc.sqltiming", Level.INFO);
    }

    @Test
    void log4jdbc_설정_파일이_적용되어_SLF4J_delegate를_쓰고_줄바꿈_제한이_없다() {
        assertThat(SpyLogFactory.getSpyLogDelegator()).isInstanceOf(Slf4jSpyLogDelegator.class);
        assertThat(Properties.getDumpSqlMaxLineLength()).isEqualTo(0);
        assertThat(Properties.isAutoLoadPopularDrivers()).isFalse();
    }

    @Test
    void 파라미터_바인딩_여러줄_SQL_들여쓰기_실행시간이_jdbc_sqltiming으로_출력된다() throws Exception {
        String sql = "SELECT item_id,\n"
                + "       title\n"
                + "  FROM virtual_items\n"
                + " WHERE district_id = ?\n"
                + "   AND title LIKE ?";

        Connection delegate = mock(Connection.class);
        DatabaseMetaData metaData = mock(DatabaseMetaData.class);
        PreparedStatement statement = mock(PreparedStatement.class);
        ResultSet resultSet = mock(ResultSet.class);
        when(metaData.getDriverName()).thenReturn("virtual-driver");
        when(delegate.getMetaData()).thenReturn(metaData);
        when(delegate.prepareStatement(sql)).thenReturn(statement);
        when(statement.executeQuery()).thenAnswer(invocation -> {
            Thread.sleep(15); // 실행 시간을 만들기 위한 가상 지연
            return resultSet;
        });

        Connection spy = new ConnectionSpy(delegate, SpyLogFactory.getSpyLogDelegator());
        try (PreparedStatement prepared = spy.prepareStatement(sql)) {
            prepared.setString(1, "D-virtual-1");
            prepared.setString(2, "%virtual%");
            assertThat(prepared.executeQuery()).isNotNull();
        }

        // 실제로 감싼 가상 delegate 가 호출되었다(단순 문자열 출력이 아님)
        verify(statement).setString(1, "D-virtual-1");
        verify(statement).setString(2, "%virtual%");
        verify(statement).executeQuery();

        String logged = capture.messages.stream().filter(m -> m.contains("virtual_items")).map(m -> m.replace("\r\n", "\n")).findFirst()
                .orElseThrow(() -> new AssertionError("jdbc.sqltiming 로그가 없습니다: " + capture.messages));

        // 파라미터가 SQL 안에 바인딩된 값으로 출력된다
        assertThat(logged).contains("district_id = 'D-virtual-1'").contains("title LIKE '%virtual%'");
        assertThat(logged).doesNotContain("= ?").doesNotContain("LIKE ?");
        // 여러 줄과 들여쓰기가 유지된다
        assertThat(logged).contains("SELECT item_id,\n       title\n  FROM virtual_items\n WHERE district_id = ");
        // 실행 시간
        assertThat(logged).containsPattern("\\{executed in \\d+ msec\\}");
        long millis = Long.parseLong(java.util.regex.Pattern.compile("\\{executed in (\\d+) msec\\}").matcher(logged)
                .results().findFirst().orElseThrow().group(1));
        assertThat(millis).isGreaterThanOrEqualTo(10);
    }

    @Test
    void SQL_앞뒤_공백과_연속_빈줄을_다듬지_않고_그대로_출력한다() throws Exception {
        assertThat(Properties.isSqlTrim()).isFalse();
        assertThat(Properties.isTrimExtraBlankLinesInSql()).isFalse();

        String sql = "\n\n  SELECT 1\n\n\n  FROM virtual_blank  \n WHERE a = ?\n\n";
        Connection delegate = mock(Connection.class);
        DatabaseMetaData metaData = mock(DatabaseMetaData.class);
        PreparedStatement statement = mock(PreparedStatement.class);
        when(metaData.getDriverName()).thenReturn("virtual-driver");
        when(delegate.getMetaData()).thenReturn(metaData);
        when(delegate.prepareStatement(sql)).thenReturn(statement);
        Connection spy = new ConnectionSpy(delegate, SpyLogFactory.getSpyLogDelegator());
        try (PreparedStatement prepared = spy.prepareStatement(sql)) {
            prepared.setString(1, "x");
            prepared.execute();
        }
        String logged = capture.messages.stream().filter(m -> m.contains("virtual_blank")).map(m -> m.replace("\r\n", "\n"))
                .findFirst().orElseThrow(() -> new AssertionError("jdbc.sqltiming 로그가 없습니다: " + capture.messages));
        // 앞쪽 빈 줄·들여쓰기, 줄 끝 공백, 연속 빈 줄이 그대로 남는다
        assertThat(logged).contains("\n\n  SELECT 1\n\n\n  FROM virtual_blank  \n WHERE a = 'x'\n\n");
    }

    @Test
    void jdbc_sqlonly_등_다른_log4jdbc_로거를_OFF로_두면_중복_출력이_없다() throws Exception {
        Capture only = new Capture();
        only.start();
        var sqlOnly = (org.apache.logging.log4j.core.Logger) LogManager.getLogger("jdbc.sqlonly");
        sqlOnly.addAppender(only);
        Configurator.setLevel("jdbc.sqlonly", Level.OFF); // application-local.yml 의 'OFF'
        try {
            Connection delegate = mock(Connection.class);
            DatabaseMetaData metaData = mock(DatabaseMetaData.class);
            PreparedStatement statement = mock(PreparedStatement.class);
            when(metaData.getDriverName()).thenReturn("virtual-driver");
            when(delegate.getMetaData()).thenReturn(metaData);
            when(delegate.prepareStatement("SELECT 1 FROM virtual_one WHERE a = ?")).thenReturn(statement);
            Connection spy = new ConnectionSpy(delegate, SpyLogFactory.getSpyLogDelegator());
            try (PreparedStatement prepared = spy.prepareStatement("SELECT 1 FROM virtual_one WHERE a = ?")) {
                prepared.setString(1, "x");
                prepared.execute();
            }
            assertThat(only.messages).isEmpty();
            assertThat(capture.messages).anyMatch(m -> m.contains("virtual_one"));
        } finally {
            sqlOnly.removeAppender(only);
            only.stop();
            Configurator.setLevel("jdbc.sqlonly", Level.INFO);
        }
    }

}
