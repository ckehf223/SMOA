package com.smoa.records;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.regex.Pattern;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.smoa.common.ApiException;

/**
 * 필드 정의({@link RecordField})에 따라 요청 값을 정규화·검증한다. 정규화된 값은 문자열(날짜 yyyy-MM-dd, 시각 HH:mm[:ss]),
 * Integer, Boolean, JSON 문자열이며 빈 문자열은 null(=지움)이 된다. 오류 메시지에 입력값은 넣지 않는다(연락처 오입력 대비).
 */
public final class FieldValidator {

    public static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
    private static final Pattern CONTROL = Pattern.compile("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]");
    private static final Pattern DATE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");
    private static final Pattern TIME = Pattern.compile("\\d{2}:\\d{2}(:\\d{2})?");
    private static final ObjectMapper JSON = new ObjectMapper();

    private FieldValidator() {
    }

    /** null 반환 = 값 없음(NULL 로 저장/지움). */
    public static Object normalize(RecordField field, Object raw) {
        switch (field.type()) {
            case STRING, TEXT -> {
                return text(field, raw);
            }
            case INT -> {
                return integer(field, raw);
            }
            case DATE -> {
                return date(field, raw);
            }
            case TIME -> {
                return time(field, raw);
            }
            case BOOL -> {
                return bool(field, raw);
            }
            case JSON -> {
                return json(field, raw);
            }
            default -> throw new IllegalStateException();
        }
    }

    private static String text(RecordField field, Object raw) {
        if (raw != null && !(raw instanceof CharSequence) && !(raw instanceof Number)) {
            throw bad(field, "문자열이어야 합니다.");
        }
        String s = raw == null ? "" : raw.toString().strip();
        if (s.isEmpty()) {
            if (field.required()) {
                throw bad(field, "필수 항목입니다.");
            }
            return null;
        }
        if (s.length() > field.max()) {
            throw bad(field, field.max() + "자 이하로 입력해 주세요.");
        }
        if (CONTROL.matcher(s).find()) {
            throw bad(field, "사용할 수 없는 문자가 있습니다.");
        }
        return s;
    }

    private static Integer integer(RecordField field, Object raw) {
        if (raw == null || raw instanceof CharSequence cs && cs.toString().isBlank()) {
            if (field.required()) {
                throw bad(field, "필수 항목입니다.");
            }
            return null;
        }
        long value;
        try {
            if (raw instanceof Integer || raw instanceof Long || raw instanceof Short || raw instanceof Byte) {
                value = ((Number) raw).longValue();
            } else if (raw instanceof Number n) {
                if (n.doubleValue() != Math.rint(n.doubleValue())) {
                    throw bad(field, "정수로 입력해 주세요.");
                }
                value = n.longValue();
            } else if (raw instanceof CharSequence cs) {
                value = Long.parseLong(cs.toString().strip());
            } else {
                throw bad(field, "정수로 입력해 주세요.");
            }
        } catch (NumberFormatException e) {
            throw bad(field, "정수로 입력해 주세요.");
        }
        if (value < field.min() || value > field.maxValue()) {
            throw bad(field, field.min() + "~" + (field.maxValue() == Integer.MAX_VALUE ? "" : field.maxValue())
                    + " 범위로 입력해 주세요.");
        }
        return (int) value;
    }

    private static String date(RecordField field, Object raw) {
        String s = raw == null ? "" : raw.toString().strip();
        if (s.isEmpty()) {
            if (field.required()) {
                throw bad(field, "필수 항목입니다.");
            }
            return null;
        }
        LocalDate d = parseDate(s);
        if (d == null) {
            throw bad(field, "YYYY-MM-DD 형식의 올바른 날짜를 입력해 주세요.");
        }
        if (field.noFuture() && d.isAfter(LocalDate.now(SEOUL))) {
            throw bad(field, "오늘 이후 날짜는 기록할 수 없습니다.");
        }
        return s;
    }

    /** yyyy-MM-dd 이고 달력상 올바르면 날짜, 아니면 null. */
    public static LocalDate parseDate(String s) {
        if (s == null || !DATE.matcher(s).matches()) {
            return null;
        }
        try {
            LocalDate d = LocalDate.parse(s);
            return d.toString().equals(s) ? d : null;
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static String time(RecordField field, Object raw) {
        String s = raw == null ? "" : raw.toString().strip();
        if (s.isEmpty()) {
            if (field.required()) {
                throw bad(field, "필수 항목입니다.");
            }
            return null;
        }
        String canonical = canonicalTime(s);
        if (canonical == null) {
            throw bad(field, "HH:mm 형식의 올바른 시각을 입력해 주세요.");
        }
        return canonical;
    }

    /** HH:mm 또는 HH:mm:ss 를 검증해 초가 0 이면 HH:mm, 아니면 HH:mm:ss 로 돌려준다. 올바르지 않으면 null. */
    public static String canonicalTime(String s) {
        if (s == null || !TIME.matcher(s).matches()) {
            return null;
        }
        try {
            LocalTime t = LocalTime.parse(s.length() == 5 ? s + ":00" : s);
            return t.getSecond() == 0 ? String.format("%02d:%02d", t.getHour(), t.getMinute())
                    : String.format("%02d:%02d:%02d", t.getHour(), t.getMinute(), t.getSecond());
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static Boolean bool(RecordField field, Object raw) {
        if (raw == null) {
            return Boolean.FALSE;
        }
        if (raw instanceof Boolean b) {
            return b;
        }
        if (raw instanceof CharSequence cs) {
            String s = cs.toString().strip();
            if (s.equalsIgnoreCase("true") || s.equalsIgnoreCase("Y")) {
                return Boolean.TRUE;
            }
            if (s.equalsIgnoreCase("false") || s.equalsIgnoreCase("N") || s.isEmpty()) {
                return Boolean.FALSE;
            }
        }
        throw bad(field, "true/false 로 입력해 주세요.");
    }

    private static String json(RecordField field, Object raw) {
        if (raw == null || raw instanceof CharSequence cs && cs.toString().isBlank()) {
            return null;
        }
        try {
            JsonNode node;
            if (raw instanceof CharSequence cs) {
                node = JSON.readTree(cs.toString());
            } else if (raw instanceof Map<?, ?>) {
                node = JSON.valueToTree(raw);
            } else {
                throw bad(field, "객체 형식이어야 합니다.");
            }
            if (node == null || !node.isObject()) {
                throw bad(field, "객체 형식이어야 합니다.");
            }
            if (node.isEmpty()) {
                return null;
            }
            String compact = JSON.writeValueAsString(node);
            if (compact.length() > field.max()) {
                throw bad(field, "크기가 너무 큽니다.");
            }
            return compact;
        } catch (JsonProcessingException e) {
            throw bad(field, "JSON 형식이 올바르지 않습니다.");
        }
    }

    /** 활동 날짜+시각 같은 분 단위 업무 시각(Asia/Seoul)을 초 :00 으로 고정한 DB 문자열로 만든다. */
    public static LocalDateTime businessDateTime(String dateOrDateTime) {
        if (dateOrDateTime == null || dateOrDateTime.isBlank()) {
            return null;
        }
        String s = dateOrDateTime.strip().replace(' ', 'T');
        try {
            if (s.length() == 10) {
                return LocalDate.parse(s).atStartOfDay();
            }
            if (s.length() == 16) {
                return LocalDateTime.parse(s + ":00");
            }
            return LocalDateTime.parse(s.length() > 19 ? s.substring(0, 19) : s).withNano(0);
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    public static ApiException bad(RecordField field, String message) {
        return ApiException.badRequest("INVALID_INPUT", field.label() + ": " + message);
    }
}
