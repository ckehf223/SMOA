package com.smoa.callingsheet;

import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 콜링시트 본표(CALLSHEET) 필드 정의. API 키·검증 규칙·컬럼 의미를 한 곳에 둔다(허용 목록 = 이 enum).
 * 연락처(phone)와 회차(rounds)는 별도 처리하며 여기에 없다. 서버 관리 값(id·rowVersion·SOURCE_*·감사)은 입력으로 받지 않는다.
 * <ul>
 *   <li>LINE: 한 줄 문자열(제어문자·줄바꿈 금지), TEXT: 여러 줄 허용, CODE: 코드/ID 문자열, ID: 숫자 ID, DATE/DATETIME: 날짜 형식</li>
 *   <li>nullable=false 인 문자열 컬럼은 비우면 빈 문자열로 저장한다(원본 표기 보존). nullable=true 는 비우면 NULL.</li>
 *   <li>personalText: 전화번호 형태가 들어오면 마스킹하고 원문은 봉인 보존하는 자유 문자열.</li>
 * </ul>
 */
public enum SheetField {

    TARGET_ID("targetId", "대상자 연결", Kind.ID, 19, true, false),
    CALL_STATUS("callStatus", "콜링 상태", Kind.LINE, 60, false, true),
    FOUND_DATE("foundDate", "찾기일", Kind.DATE, 10, true, false),
    CALL_RESULT("callResult", "콜링 결과", Kind.LINE, 100, false, true),
    TARGET_NAME("targetName", "대상자", Kind.LINE, 100, false, true),
    INTRO_EMPL_ID("introducerId", "인도자 명부 연결", Kind.CODE, 60, true, false),
    INTRO_NAME("introducerName", "인도자", Kind.LINE, 100, false, true),
    REGION_CODE("regionCode", "지역", Kind.CODE, 60, true, false),
    DISTRICT_CODE("districtCode", "구역", Kind.CODE, 60, true, false),
    SEX_CODE("sexCode", "성별", Kind.LINE, 20, false, true),
    AGE_TEXT("ageText", "나이", Kind.LINE, 60, false, true),
    RESIDENCE("residence", "거주지", Kind.LINE, 200, false, true),
    PREFERRED_PLACE("preferredPlace", "선호 장소", Kind.LINE, 200, false, true),
    NOTES("notes", "특이사항", Kind.TEXT, 5000, false, true),
    CONSULT_TOPIC("consultTopic", "컨설팅 주제", Kind.LINE, 200, false, true),
    MANPIK_CONFIRMED_AT("manpikConfirmedAt", "만픽 확정 날짜", Kind.DATETIME, 19, true, false),
    MANPIK_INFO("manpikInfo", "만픽 정보", Kind.TEXT, 5000, false, true),
    ASSIGNED_USER_ID("assignedUserId", "콜링 담당 계정 연결", Kind.CODE, 50, true, false),
    ASSIGNED_USER_NAME("assignedUserName", "콜링 담당", Kind.LINE, 100, false, true);

    public enum Kind { LINE, TEXT, CODE, ID, DATE, DATETIME }

    private final String key;
    private final String label;
    private final Kind kind;
    private final int max;
    private final boolean nullable;
    private final boolean personalText;

    SheetField(String key, String label, Kind kind, int max, boolean nullable, boolean personalText) {
        this.key = key;
        this.label = label;
        this.kind = kind;
        this.max = max;
        this.nullable = nullable;
        this.personalText = personalText;
    }

    public String key() {
        return key;
    }

    public String label() {
        return label;
    }

    public Kind kind() {
        return kind;
    }

    public int max() {
        return max;
    }

    public boolean nullable() {
        return nullable;
    }

    public boolean personalText() {
        return personalText;
    }

    private static final Map<String, SheetField> BY_KEY = Arrays.stream(values())
            .collect(Collectors.toUnmodifiableMap(SheetField::key, Function.identity()));

    public static SheetField ofKey(String key) {
        return BY_KEY.get(key);
    }

    public static List<String> keys() {
        return Arrays.stream(values()).map(SheetField::key).toList();
    }
}
