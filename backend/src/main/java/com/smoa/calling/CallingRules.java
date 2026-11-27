package com.smoa.calling;

import java.text.Collator;
import java.text.Normalizer;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.format.DateTimeParseException;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

import com.smoa.calling.CallingRecord.Outcome;
import com.smoa.calling.CallingRecord.Round;
import com.smoa.common.ApiException;

final class CallingRules {
    static final List<String> ROUNDS = List.of("신규", "1차", "2차", "3차", "4차", "추가회차");
    static final List<String> RESULTS = List.of("만픽", "부재", "재통화", "거절", "기타");
    private static final Set<String> CALLBACK = Set.of("재콜요청", "차후재콜링");
    private static final Pattern NUMBERED = Pattern.compile("^(\\d+)(?:회)?차$");
    private static final Pattern SPACE = Pattern.compile("(?U)\\s+");
    private static final Pattern CONTROL = Pattern.compile("[\\p{Cc}&&[^\\t\\r\\n]]");
    private static final Pattern PHONE = Pattern.compile("(?<!\\d)(?:\\+?82[- .]?0?|0)\\d{1,2}[- .]?(\\d{3,4})[- .]?(\\d{4})(?!\\d)");
    private static final ThreadLocal<Collator> COLLATOR = ThreadLocal.withInitial(() -> Collator.getInstance(Locale.KOREAN));
    static final Comparator<String> KOREAN = Comparator.nullsFirst((left, right) -> COLLATOR.get().compare(left, right));
    static final Comparator<Round> ROUND_ORDER = (left, right) -> {
        int leftGroup = group(left);
        int rightGroup = group(right);
        if (leftGroup != rightGroup) return Integer.compare(leftGroup, rightGroup);
        var a = NUMBERED.matcher(left.label());
        var b = NUMBERED.matcher(right.label());
        if (a.matches() && b.matches()) {
            int digits = Integer.compare(a.group(1).length(), b.group(1).length());
            return digits == 0 ? a.group(1).compareTo(b.group(1)) : digits;
        }
        return KOREAN.compare(left.label(), right.label());
    };

    private CallingRules() {
    }

    private static int group(Round round) {
        if (round.name() != null) return 1;
        return round.number() == 0 ? 0 : round.number() == 5 ? 2 : 1;
    }

    static String searchKey(String text) {
        return SPACE.matcher(normalize(text)).replaceAll("");
    }

    static String callerKey(String text) {
        return SPACE.matcher(normalize(text)).replaceAll(" ").strip();
    }

    private static String normalize(String text) {
        return text == null ? "" : Normalizer.normalize(text, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
    }

    static Round parseRound(String value, boolean legacyFifth) {
        String label = Normalizer.normalize(text(value, 60, "콜링 차수", true), Normalizer.Form.NFKC).strip();
        if (label.length() > 60 || label.codePoints().anyMatch(Character::isISOControl)) {
            throw invalid("콜링 차수 또는 회차 이름을 확인해 주세요.");
        }
        String key = searchKey(label);
        if (key.equals("추가") || legacyFifth && key.equals("5차")) return new Round(5, null);
        for (int i = 0; i < ROUNDS.size(); i++) {
            if (key.equals(Integer.toString(i)) || key.equals(ROUNDS.get(i))) return new Round(i, null);
        }
        if (key.matches("\\d+")) throw invalid("콜링 차수 또는 회차 이름을 확인해 주세요.");
        var numbered = NUMBERED.matcher(key);
        if (!numbered.matches()) return new Round(5, mask(label.replaceAll("(?U)\\s+", " ")));
        String digits = numbered.group(1).replaceFirst("^0+", "");
        if (digits.isEmpty()) throw invalid("콜링 차수 또는 회차 이름을 확인해 주세요.");
        if (digits.matches("[1-4]") || legacyFifth && digits.equals("5")) {
            return new Round(Integer.parseInt(digits), null);
        }
        return new Round(5, digits + "차");
    }

    static Outcome parseOutcome(String value, boolean migration) {
        String original = mask(text(value, 100, "콜링 결과", true));
        String key = searchKey(original);
        if (RESULTS.contains(key)) return new Outcome(key, null, key.equals(original) ? null : original);
        if (!migration && CALLBACK.contains(key)) return new Outcome("재통화", null, original);
        return new Outcome(key.equals("재콜링") ? "재통화" : "기타", original, null);
    }

    static String text(String input, int max, String label, boolean required) {
        String value = input == null ? "" : input.strip();
        if (value.length() > max || CONTROL.matcher(value).find() || required && value.isBlank()) {
            throw invalid(label + " 항목을 확인해 주세요.");
        }
        return value;
    }

    static LocalDate date(String value, boolean required) {
        String input = text(value, 10, "날짜", required);
        if (input.isEmpty()) return null;
        try {
            if (!input.matches("\\d{4}-\\d{2}-\\d{2}")) throw invalid("날짜를 확인해 주세요.");
            LocalDate date = LocalDate.parse(input);
            if (date.getYear() < 1000) throw invalid("날짜를 확인해 주세요.");
            return date;
        } catch (DateTimeParseException ex) {
            throw invalid("날짜를 확인해 주세요.");
        }
    }

    static LocalTime time(String value) {
        String input = text(value, 8, "콜링 시간", false);
        if (input.isEmpty()) return null;
        try {
            return LocalTime.parse(input);
        } catch (DateTimeParseException ex) {
            throw invalid("콜링 시간을 확인해 주세요.");
        }
    }

    static String mask(String value) {
        return value == null ? null : PHONE.matcher(value).replaceAll("***-****-$2");
    }

    static boolean id(String value) {
        return value != null && value.matches("[1-9]\\d{0,19}")
                && (value.length() < 20 || value.compareTo("18446744073709551615") <= 0);
    }

    static ApiException invalid(String message) {
        return ApiException.badRequest("INVALID_CALLING_INPUT", message);
    }
}
