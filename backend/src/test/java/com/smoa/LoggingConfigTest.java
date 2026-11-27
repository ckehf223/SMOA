package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ServiceLoader;
import java.util.UUID;
import java.util.regex.Pattern;

import javax.xml.parsers.DocumentBuilderFactory;

import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.Appender;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.config.Configuration;
import org.apache.logging.log4j.core.impl.Log4jLogEvent;
import org.apache.logging.log4j.core.layout.PatternLayout;
import org.apache.logging.log4j.message.SimpleMessage;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.spi.SLF4JServiceProvider;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.w3c.dom.Document;
import org.w3c.dom.Element;

/**
 * Log4j2 단일 구현, 콘솔 ANSI 색상, 파일 로그 생성, log4j2.xml 정의를 실제 로깅 시스템(Boot 기동 후)으로 검증한다.
 * Gradle/IntelliJ 테스트 JVM 은 System.console()==null 이지만 disableAnsi=false 라서 색상 코드가 그대로 나온다.
 */
@SpringBootTest(properties = "smoa.security.bcrypt-strength=4")
@ActiveProfiles("local-memory")
class LoggingConfigTest {

    private static final String FILE_LAYOUT =
            "%style{%d{yyyy/MM/dd HH:mm:ss,SSS}}{cyan} %highlight{[%-5p]}{FATAL=bg_red, ERROR=red, INFO=green, DEBUG=blue} [%c{1.}] %style{[%t]}{yellow}- %m%n";

    private static final String CONSOLE_LAYOUT =
            "%style{%d{yyyy/MM/dd HH:mm:ss,SSS}}{cyan} %highlight{[%-5p]}{FATAL=bg_red, ERROR=red, INFO=green, DEBUG=blue} [%c] %style{[%t]}{yellow}- %m%n";

    @Test
    void SLF4J_provider는_Log4j2_하나뿐이고_Logback은_클래스패스에_없다() {
        var providers = ServiceLoader.load(SLF4JServiceProvider.class).stream().toList();
        assertThat(providers).hasSize(1);
        assertThat(providers.get(0).type().getName()).startsWith("org.apache.logging");
        assertThat(LoggerFactory.getILoggerFactory().getClass().getName()).startsWith("org.apache.logging");
        assertThatThrownBy(() -> Class.forName("ch.qos.logback.classic.Logger")).isInstanceOf(ClassNotFoundException.class);
    }

    private static Document log4j2Xml() throws Exception {
        try (InputStream in = LoggingConfigTest.class.getResourceAsStream("/log4j2.xml")) {
            return DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(in);
        }
    }

    private static Element first(Document doc, String tag) {
        return (Element) doc.getElementsByTagName(tag).item(0);
    }

    @Test
    void log4j2_xml_정의가_요구_사항과_같다() throws Exception {
        Document doc = log4j2Xml();

        // 콘솔 레이아웃은 한 줄이어야 들여쓰기 공백이 메시지 앞에 섞이지 않는다.
        var properties = doc.getElementsByTagName("Property");
        String consoleLayout = null;
        String fileLayout = null;
        for (int i = 0; i < properties.getLength(); i++) {
            Element p = (Element) properties.item(i);
            if ("consoleLayout".equals(p.getAttribute("name"))) {
                consoleLayout = p.getTextContent();
            }
            if ("fileLayout".equals(p.getAttribute("name"))) {
                fileLayout = p.getTextContent();
            }
        }
        assertThat(consoleLayout).isEqualTo(CONSOLE_LAYOUT);
        // 사용자가 요청한 원래 fileLayout 과 같아야 한다(임의로 plain 으로 바꾸지 않는다)
        assertThat(fileLayout).isEqualTo(FILE_LAYOUT).doesNotContain("\n");
        Element filePattern = (Element) first(doc, "RollingFile").getElementsByTagName("PatternLayout").item(0);
        assertThat(filePattern.getAttribute("pattern")).isEqualTo("${fileLayout}");
        assertThat(filePattern.getAttribute("disableAnsi")).isEqualTo("false");

        Element consolePattern = (Element) first(doc, "Console").getElementsByTagName("PatternLayout").item(0);
        assertThat(consolePattern.getAttribute("disableAnsi")).isEqualTo("false");
        assertThat(consolePattern.getAttribute("pattern")).isEqualTo("${consoleLayout}");

        Element rolling = first(doc, "RollingFile");
        assertThat(rolling.getAttribute("fileName")).isEqualTo("${LOG_DIR}/${LOG_NAME}.log");
        assertThat(rolling.getAttribute("filePattern")).isEqualTo("${LOG_DIR}/${LOG_NAME}.%d{yyyy-MM-dd}.log");
        Element policy = first(doc, "TimeBasedTriggeringPolicy");
        assertThat(policy.getAttribute("interval")).isEqualTo("1");
        assertThat(policy.getAttribute("modulate")).isEqualTo("true");
        Element strategy = first(doc, "DefaultRolloverStrategy");
        assertThat(strategy.getAttribute("max")).isEqualTo("10");
        assertThat(strategy.getAttribute("fileIndex")).isEqualTo("min");

        Element smoa = null;
        var loggers = doc.getElementsByTagName("Logger");
        for (int i = 0; i < loggers.getLength(); i++) {
            Element l = (Element) loggers.item(i);
            if ("com.smoa".equals(l.getAttribute("name"))) {
                smoa = l;
            }
        }
        assertThat(smoa).isNotNull();
        assertThat(smoa.getAttribute("level")).isEqualTo("INFO");
        assertThat(smoa.getAttribute("additivity")).isEqualTo("false");
        assertThat(first(doc, "Root").getAttribute("level")).isEqualTo("INFO");

        // 실제 로드된 설정에서도 같은 값(LOG_DIR/LOG_NAME 치환 결과)
        Configuration live = ((LoggerContext) LogManager.getContext(false)).getConfiguration();
        var file = (org.apache.logging.log4j.core.appender.RollingFileAppender) live.getAppender("File");
        assertThat(file.getFileName()).isEqualTo("logs/smoa-backend.log");
        assertThat(file.getFilePattern()).isEqualTo("logs/smoa-backend.%d{yyyy-MM-dd}.log");
        assertThat(live.getLoggerConfig("com.smoa.anything").isAdditive()).isFalse();
    }

    @Test
    void 콘솔_출력은_IDE처럼_console이_없어도_ANSI_색상을_유지하고_메시지_앞에_공백이_없다() {
        Configuration live = ((LoggerContext) LogManager.getContext(false)).getConfiguration();
        Appender console = live.getAppender("Console");
        PatternLayout layout = (PatternLayout) console.getLayout();

        String info = layout.toSerializable(event(Level.INFO, "hello", null));
        assertThat(info).contains("\u001B[");                 // ANSI 이스케이프
        assertThat(info).contains("\u001B[36m");              // 시간: cyan
        assertThat(info).contains("\u001B[32m").contains("[INFO ]"); // INFO: green
        assertThat(info).contains("[com.smoa.logtest]").contains("\u001B[33m[main]");
        assertThat(info).endsWith("- hello" + System.lineSeparator());
        assertThat(info).doesNotContain("-  hello").doesNotContain("- \t");

        assertThat(layout.toSerializable(event(Level.ERROR, "bad", null))).contains("\u001B[31m");
        assertThat(layout.toSerializable(event(Level.DEBUG, "dbg", null))).contains("\u001B[34m");
        assertThat(layout.toSerializable(event(Level.FATAL, "dead", null))).contains("\u001B[41m");
    }

    @Test
    void 예외_스택트레이스는_콘솔과_파일_레이아웃_모두에서_유지된다() {
        Configuration live = ((LoggerContext) LogManager.getContext(false)).getConfiguration();
        Throwable error = new IllegalStateException("virtual-failure");
        for (String name : new String[] {"Console", "File"}) {
            PatternLayout layout = (PatternLayout) live.getAppender(name).getLayout();
            String out = layout.toSerializable(event(Level.ERROR, "failed", error));
            assertThat(out).as(name).contains("IllegalStateException: virtual-failure").contains("\tat ");
        }
    }

    private static Log4jLogEvent event(Level level, String message, Throwable thrown) {
        return Log4jLogEvent.newBuilder().setLoggerName("com.smoa.logtest").setLevel(level)
                .setMessage(new SimpleMessage(message)).setThreadName("main").setThrown(thrown).build();
    }

    @Test
    void 로그_파일이_만들어지고_요청한_패턴_축약_클래스명으로_한_번만_기록된다() throws Exception {
        Logger logger = LoggerFactory.getLogger("com.smoa.logtest");
        String marker = "marker-" + UUID.randomUUID();
        logger.info(marker);

        Path file = Path.of(System.getProperty("user.dir"), "logs", "smoa-backend.log");
        assertThat(file).exists();
        String content = Files.readString(file, StandardCharsets.UTF_8);
        assertThat(content).containsOnlyOnce(marker); // additivity=false 로 중복 기록 없음
        String line = content.lines().filter(l -> l.contains(marker)).findFirst().orElseThrow();
        // 요청한 fileLayout 은 %style/%highlight 를 쓰므로 파일에도 ANSI 색상 코드가 들어간다(cyan 시간, green INFO, yellow 스레드)
        assertThat(line).contains("\u001B[36m").contains("\u001B[32m").contains("\u001B[33m");
        line = line.replaceAll("\u001B\\[[;\\d]*m", "");
        assertThat(line).matches(Pattern.compile(
                "\\d{4}/\\d{2}/\\d{2} \\d{2}:\\d{2}:\\d{2},\\d{3} \\[INFO \\] \\[c\\.s\\.logtest\\] \\[.+\\]- " + marker));
    }
}
