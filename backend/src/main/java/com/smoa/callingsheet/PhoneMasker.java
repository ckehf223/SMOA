package com.smoa.callingsheet;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 자유 문자열에 섞인 전화번호를 평문으로 저장하지 않기 위한 마스킹. 전화번호 후보는 0 또는 + 로 시작하고 숫자가 9~15개인
 * 연속 구간(공백·하이픈·점·괄호 허용)이다. 생년월일(1995-03-12)·연도·시각은 0/+ 로 시작하지 않아 걸리지 않는다.
 * 마스킹 결과는 끝 네 자리만 남기고 숫자를 '*' 로 바꾸며 구분 기호 위치는 유지한다(예: 010-****-5678).
 * 원문 번호 목록은 호출자가 봉인(ContactVault)해서만 보존하며 이 클래스는 어디에도 기록하지 않는다.
 */
public final class PhoneMasker {

    private static final Pattern CANDIDATE = Pattern.compile("(?<!\\d)[+0][\\d\\-. ()]{7,22}\\d(?!\\d)");

    public record Masked(String text, List<String> numbers) {
        public boolean found() {
            return !numbers.isEmpty();
        }
    }

    private PhoneMasker() {
    }

    public static Masked mask(String text) {
        if (text == null || text.isEmpty()) {
            return new Masked(text, List.of());
        }
        Matcher m = CANDIDATE.matcher(text);
        StringBuilder out = new StringBuilder();
        List<String> numbers = new ArrayList<>();
        while (m.find()) {
            String candidate = m.group();
            int digits = (int) candidate.chars().filter(Character::isDigit).count();
            if (digits < 9 || digits > 15) {
                m.appendReplacement(out, Matcher.quoteReplacement(candidate));
                continue;
            }
            numbers.add(candidate.strip());
            m.appendReplacement(out, Matcher.quoteReplacement(maskDigits(candidate, digits)));
        }
        m.appendTail(out);
        return new Masked(out.toString(), numbers);
    }

    private static String maskDigits(String candidate, int digits) {
        StringBuilder sb = new StringBuilder(candidate.length());
        int seen = 0;
        for (char c : candidate.toCharArray()) {
            if (Character.isDigit(c)) {
                seen++;
                sb.append(seen > digits - 4 ? c : '*');
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    /** 전화번호 형태가 하나라도 있는가(회차 담당자 이름처럼 보존 없이 거부할 값 검사). */
    public static boolean containsPhone(String text) {
        return mask(text).found();
    }
}
