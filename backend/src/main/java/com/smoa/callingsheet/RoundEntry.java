package com.smoa.callingsheet;

import java.util.List;
import java.util.regex.Pattern;

/**
 * 회차 담당자(CALLSHEETROUND 한 행). 기본 1~5차(코드 "1"~"5")와 사용자 회차를 같은 모양으로 표현한다.
 * callerName 은 원본(노션) 표기 스냅샷이며 계정을 자동 생성하지 않는다. callerUserId 는 선택적 계정 연결이다.
 * 이 기록은 시트 메타이며 실제 콜링 시도(CALLMSTR)가 아니다.
 */
public record RoundEntry(String code, String label, String callerUserId, String callerName) {

    public static final Pattern CODE = Pattern.compile("[0-9A-Za-z_\\-\\p{IsHangul}]{1,30}");
    public static final int MAX_ROUNDS = 20;
    public static final List<String> DEFAULT_CODES = List.of("1", "2", "3", "4", "5");

    public static String defaultLabel(String code) {
        return DEFAULT_CODES.contains(code) ? code + "차" : code;
    }

    /** 숫자 코드는 숫자 순, 그 밖은 코드 문자열 순(숫자 먼저). */
    public static int compareCodes(String a, String b) {
        boolean an = a.chars().allMatch(Character::isDigit);
        boolean bn = b.chars().allMatch(Character::isDigit);
        if (an && bn) {
            int c = Integer.compare(a.length(), b.length());
            return c != 0 ? c : a.compareTo(b);
        }
        if (an != bn) {
            return an ? -1 : 1;
        }
        return a.compareTo(b);
    }
}
