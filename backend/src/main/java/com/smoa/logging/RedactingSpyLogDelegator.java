package com.smoa.logging;

import java.sql.SQLException;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

import net.sf.log4jdbc.log.slf4j.Slf4jSpyLogDelegator;
import net.sf.log4jdbc.sql.resultsetcollector.ResultSetCollector;
import net.sf.log4jdbc.sql.Spy;

/**
 * log4jdbc 의 SLF4J 위임자(jdbc.sqltiming 출력)에 개인정보 가리기를 더한 것.
 *
 * <p>SQL: log4jdbc 는 바인딩된 값을 SQL 문자열 안에 채워 출력한다. 업무 개인정보가 들어 있는 테이블(대상자·활동·콜링·명부·계정·이력 등)을
 * 건드리는 문장은 <b>컬럼이 무엇이든</b> 모든 문자열 리터럴·개인값이 될 수 있는 숫자 리터럴·주석 내용을 가린다.
 * 컬럼 목록·조건 식·들여쓰기·줄바꿈·실행 시간은 그대로라서 성능 확인에는 지장이 없다. 그 밖의 일반 문장(코드·조직·권한 패키지 등)은 바인딩 값까지
 * 원문 그대로 보인다. PHONE_ENC 등 민감 컬럼 이름이 보이는 문장은 어떤 테이블이든 민감으로 본다.
 *
 * <p>예외: 드라이버 예외 메시지에는 중복 값·잘린 값·SQL 리터럴이 들어갈 수 있고 methodCall 에는 setString 인자 값이 들어갈 수 있다.
 * 원본 예외·원인 체인·메서드 인자는 전혀 로그로 넘기지 않고 SQLState·오류 코드·예외 종류만 가진 새 예외를 넘긴다.
 *
 * <p>log4jdbc.log4j2.properties 의 log4jdbc.spylogdelegator.name 으로 등록한다.
 */
public class RedactingSpyLogDelegator extends Slf4jSpyLogDelegator {

    private static final String REDACTED = "[REDACTED]";

    /** 개인정보가 들어 있는 업무 테이블(대소문자·백틱·스키마 접두어 무관). */
    static final Set<String> SENSITIVE_TABLES = Set.of(
            "TGMSTR", "TGSTGLOG", "TGSTATLOG", "ACTMSTR", "ORGACT", "CALLMSTR", "SOCMSTR", "SOCDTL",
            "DAYMSTR", "DAYDTL", "PSMSTR", "USERMSTR", "CHGLOG", "MIGMAP", "SYSCFG", "CALLSHEET", "CALLSHEETROUND", "AFTRPT");

    private static final Pattern SENSITIVE_NAME = Pattern.compile(
            "(?<![\\p{L}\\p{N}_$])(?:" + String.join("|", SENSITIVE_TABLES)
                    + "|PHONE_ENC|PHONE_LAST4|PASSWORD_HASH|SOURCE_ENC|BEFORE_JSON|AFTER_JSON)(?![\\p{L}\\p{N}_$])",
            Pattern.CASE_INSENSITIVE);
    /** 숫자 리터럴 전체(소수·지수) 모양. */
    private static final Pattern NUMBER = Pattern.compile("\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?");
    private static final Pattern PLAIN_ID_COLUMN = Pattern.compile("(?i)[A-Z0-9_]*_ID|ROW_VERSION|SEQ_NO|SEQ|ACT_YEAR|ACT_MONTH");
    private static final Pattern PERSONAL_ID_COLUMN = Pattern.compile("(?i).*(EMPL|USER|LOGIN|ACTOR|RUSR|MUSR|GUIDE|LEADER|TEACHER|PERSON|MEMBER).*");

    /** 민감 문장이면 값(문자열·숫자·주석)을 가린 SQL, 아니면 원본 그대로. */
    public static String redact(String sql) {
        if (sql == null || sql.isEmpty()) {
            return sql;
        }
        return SENSITIVE_NAME.matcher(sql).find() ? scrub(sql) : sql;
    }

    /** SQL 을 한 번 훑으며 리터럴·주석 내용만 바꾼다. 식별자(백틱 포함)·연산자·공백은 그대로 둔다. */
    private static String scrub(String s) {
        StringBuilder out = new StringBuilder(s.length());
        int n = s.length();
        int i = 0;
        String prevWord = "";
        String between = "";   // prevWord 이후 만난 비공백 기호
        boolean limitMode = false;
        while (i < n) {
            char c = s.charAt(i);
            if (c == '\'' || c == '"') {
                i = skipQuoted(s, i, c);
                out.append(c).append(REDACTED).append(c);
                between += "'";
                limitMode = false;
            } else if (c == '`') {
                int j = i + 1;
                while (j < n) {
                    if (s.charAt(j) == '`') {
                        if (j + 1 < n && s.charAt(j + 1) == '`') {
                            j += 2;
                            continue;
                        }
                        break;
                    }
                    j++;
                }
                int end = Math.min(j + 1, n);
                out.append(s, i, end);
                prevWord = stripTicks(s.substring(i, end));
                between = "";
                limitMode = false;
                i = end;
            } else if (c == '/' && i + 1 < n && s.charAt(i + 1) == '*') {
                int end = s.indexOf("*/", i + 2);
                end = end < 0 ? n : end + 2;
                out.append("/* ").append(REDACTED).append(" */");
                i = end;
            } else if (c == '#' || (c == '-' && i + 1 < n && s.charAt(i + 1) == '-'
                    && (i + 2 >= n || Character.isWhitespace(s.charAt(i + 2)) || Character.isISOControl(s.charAt(i + 2))))) {
                int end = i;
                while (end < n && s.charAt(end) != '\n' && s.charAt(end) != '\r') {
                    end++;
                }
                out.append(c == '#' ? "# " : "-- ").append(REDACTED);
                i = end;
            } else if (Character.isDigit(c) || (c == '.' && i + 1 < n && Character.isDigit(s.charAt(i + 1)) && !prevIsWordChar(s, i))) {
                int j = i;
                if (c == '0' && i + 1 < n && (s.charAt(i + 1) == 'x' || s.charAt(i + 1) == 'X')) {
                    j = i + 2;
                    while (j < n && isWord(s.charAt(j))) {
                        j++;
                    }
                } else {
                    var m = NUMBER.matcher(s);
                    m.region(c == '.' ? i + 1 : i, n);
                    j = m.lookingAt() ? m.end() : i + 1;
                    if (c == '.') {
                        j = Math.max(j, i + 1);
                    }
                    if (j < n && isWord(s.charAt(j))) { // 1abc 같은 식별자
                        while (j < n && isWord(s.charAt(j))) {
                            j++;
                        }
                        out.append(s, i, j);
                        prevWord = s.substring(i, j);
                        between = "";
                        i = j;
                        continue;
                    }
                }
                if (keepNumber(prevWord, between, limitMode)) {
                    out.append(s, i, j);
                } else {
                    out.append(REDACTED);
                }
                i = j;
            } else if (isWord(c)) {
                int j = i;
                while (j < n && isWord(s.charAt(j))) {
                    j++;
                }
                String word = s.substring(i, j);
                out.append(word);
                String upper = word.toUpperCase(Locale.ROOT);
                limitMode = upper.equals("LIMIT") || upper.equals("OFFSET");
                prevWord = word;
                between = "";
                i = j;
            } else {
                out.append(c);
                if (!Character.isWhitespace(c)) {
                    between += c;
                    if (c != ',') {
                        limitMode = false;
                    }
                }
                i++;
            }
        }
        return out.toString();
    }

    private static boolean keepNumber(String prevWord, String between, boolean limitMode) {
        if (limitMode) {
            return true; // LIMIT 20 OFFSET 40, LIMIT 40, 20
        }
        if (prevWord.isEmpty() || !between.matches("[=<>!]{1,3}")) {
            return false;
        }
        if (!PLAIN_ID_COLUMN.matcher(prevWord).matches() || PERSONAL_ID_COLUMN.matcher(prevWord).matches()) {
            return false;
        }
        return true;
    }

    private static int skipQuoted(String s, int start, char quote) {
        int n = s.length();
        int j = start + 1;
        while (j < n) {
            char d = s.charAt(j);
            if (d == '\\') {
                j += 2;
                continue;
            }
            if (d == quote) {
                if (j + 1 < n && s.charAt(j + 1) == quote) {
                    j += 2;
                    continue;
                }
                return j + 1;
            }
            j++;
        }
        return n; // 닫히지 않은 리터럴도 끝까지 가린다
    }

    private static String stripTicks(String quoted) {
        return quoted.length() >= 2 ? quoted.substring(1, quoted.length() - 1).replace("``", "`") : quoted;
    }

    private static boolean isWord(char c) {
        return Character.isLetterOrDigit(c) || c == '_' || c == '$';
    }

    private static boolean prevIsWordChar(String s, int i) {
        return i > 0 && (isWord(s.charAt(i - 1)) || s.charAt(i - 1) == '`');
    }

    /** methodCall 에서 메서드 이름만 남긴다(인자에는 바인딩 값이 들어갈 수 있다). */
    static String safeMethod(String methodCall) {
        if (methodCall == null) {
            return "";
        }
        int paren = methodCall.indexOf('(');
        String name = paren >= 0 ? methodCall.substring(0, paren) : methodCall;
        name = name.trim();
        return name.matches("[A-Za-z0-9_.$]{1,80}") ? name + "(...)" : "(...)";
    }

    /** 드라이버 예외 대신 로그로 넘길 정제 예외(원인·원본 메시지 없음). */
    static Exception sanitize(Exception e) {
        if (e instanceof SQLException sql) {
            String state = sql.getSQLState() == null ? "" : sql.getSQLState().replaceAll("[^A-Za-z0-9]", "");
            return new SQLException("SQL error (details withheld): " + e.getClass().getSimpleName(), state.isEmpty() ? null : state,
                    sql.getErrorCode());
        }
        return new RuntimeException("JDBC error (details withheld): " + (e == null ? "unknown" : e.getClass().getSimpleName()));
    }

    @Override
    public void sqlOccurred(Spy spy, String methodCall, String sql) {
        super.sqlOccurred(spy, safeMethod(methodCall), redact(sql));
    }

    @Override
    public void sqlTimingOccurred(Spy spy, long execTime, String methodCall, String sql) {
        super.sqlTimingOccurred(spy, execTime, safeMethod(methodCall), redact(sql));
    }

    @Override
    public void exceptionOccured(Spy spy, String methodCall, Exception e, String sql, long execTime) {
        super.exceptionOccured(spy, safeMethod(methodCall), sanitize(e), redact(sql), execTime);
    }

    @Override
    public void methodReturned(Spy spy, String methodCall, String returnMsg) {
        super.methodReturned(spy, safeMethod(methodCall), "");
    }

    /** 결과 집합 값 표는 어떤 로거에도 출력하지 않는다(jdbc.resultset/resultsettable 은 OFF 유지, 켜져도 값은 안 나옴). */
    @Override
    public boolean isResultSetCollectionEnabled() {
        return false;
    }

    @Override
    public boolean isResultSetCollectionEnabledWithUnreadValueFillIn() {
        return false;
    }

    @Override
    public void resultSetCollected(ResultSetCollector resultSetCollector) {
        // 출력하지 않는다.
    }
}
