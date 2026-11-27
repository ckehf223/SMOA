package com.smoa.records;

import java.util.Arrays;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 대상자(TGMSTR) 필드. 원본 엑셀/데스크톱 필드를 빠짐없이 담는다(찾은 날짜·시간, 나이 기준일, 장소·도구·거주지·교사·사유·담당자,
 * 인도자 ID/스냅샷, 분류1/2, 반·직업, 상태·단계·8개 마일스톤 날짜, 확정 일정, 사용자 정의, 메모).
 * 연락처는 이 정의에 없다(전용 경로 + 암호화). ID/법적 PK 는 TGT_ID(AUTO_INCREMENT) 이며 필드가 아니다.
 */
public enum PersonField implements RecordField {

    CODE("code", "식별번호", Type.STRING, 60, false, true),
    NAME("name", "이름", Type.STRING, 100, true, true),
    GENDER("gender", "성별", Type.STRING, 20, false, true),
    AGE("age", "나이", Type.INT, 0, false, true),
    AGE_AS_OF("ageAsOf", "나이 기준일", Type.DATE, 0, false, true),
    FOUND_DATE("foundDate", "찾은 날짜", Type.DATE, 0, false, true),
    FOUND_TIME("foundTime", "찾은 시간", Type.TIME, 0, false, true),
    DATE_UNKNOWN("dateUnknown", "찾은 날짜 미상", Type.BOOL, 0, false, true),
    CLASSIFICATION1("classification1", "분류1", Type.STRING, 20, false, true),
    CLASSIFICATION2("classification2", "분류2", Type.STRING, 20, false, true),
    PLACE("place", "찾은 장소", Type.STRING, 200, false, true),
    TOOL("tool", "사용 도구", Type.STRING, 200, false, true),
    RESIDENCE("residence", "거주지", Type.STRING, 200, false, true),
    TEACHER("teacher", "교사", Type.STRING, 100, false, true),
    REASON("reason", "사유", Type.TEXT, 2000, false, true),
    WORKER("worker", "담당자", Type.STRING, 100, false, true),
    INTRODUCER_ID("introducerId", "인도자 ID", Type.STRING, 60, false, true),
    INTRODUCER_CODE("introducerCode", "인도자 구성원ID", Type.STRING, 60, false, true),
    INTRODUCER_NAME("introducerName", "인도자 이름", Type.STRING, 100, false, true),
    INTRODUCER_ORG("introducerOrg", "인도자 소속", Type.STRING, 300, false, true),
    CLASS_NAME("className", "반", Type.STRING, 60, false, true),
    EMPLOYMENT("employment", "직업", Type.STRING, 60, false, true),
    APPOINTMENT("appointment", "확정 일정", Type.STRING, 30, false, true),
    NOTES("notes", "메모", Type.TEXT, 5000, false, true),
    CUSTOM("custom", "사용자 정의 항목", Type.JSON, 20000, false, true),
    MANPIK_DATE("manpikDate", "만픽일", Type.DATE, 0, false, true),
    FIND_A_DATE("findADate", "찾A일", Type.DATE, 0, false, true),
    HAB_B_DATE("habBDate", "합B일", Type.DATE, 0, false, true),
    HAB_A_DATE("habADate", "합A(육따)일", Type.DATE, 0, false, true),
    YOUNG_TTA_DATE("youngTtaDate", "영따일", Type.DATE, 0, false, true),
    BOKSHIN_DATE("bokshinDate", "복신일", Type.DATE, 0, false, true),
    CARD_RECEIVED_DATE("cardReceivedDate", "신카접수일", Type.DATE, 0, false, true),
    CENTER_REGISTERED_DATE("centerRegisteredDate", "센터등록일", Type.DATE, 0, false, true),
    // ---- 서버 전용 경로로만 바뀌는 필드(요청 본문의 일반 수정으로는 바꿀 수 없다) ----
    REGION_CODE("regionCode", "지역", Type.STRING, 64, false, false),
    DISTRICT_CODE("districtCode", "구역", Type.STRING, 64, false, false),
    STAGE("stageId", "단계", Type.STRING, 60, false, false),
    STATUS("status", "상태", Type.STRING, 20, false, false),
    DELETED("deleted", "삭제", Type.BOOL, 0, false, false);

    private static final Map<String, PersonField> BY_KEY =
            Arrays.stream(values()).collect(Collectors.toUnmodifiableMap(PersonField::key, Function.identity()));

    private final String key;
    private final String label;
    private final Type type;
    private final int max;
    private final boolean required;
    private final boolean editable;

    PersonField(String key, String label, Type type, int max, boolean required, boolean editable) {
        this.key = key;
        this.label = label;
        this.type = type;
        this.max = max;
        this.required = required;
        this.editable = editable;
    }

    public static Optional<PersonField> byKey(String key) {
        return Optional.ofNullable(BY_KEY.get(key));
    }

    @Override
    public String key() {
        return key;
    }

    @Override
    public String label() {
        return label;
    }

    @Override
    public Type type() {
        return type;
    }

    @Override
    public int max() {
        return max;
    }

    @Override
    public boolean required() {
        return required;
    }

    @Override
    public boolean editable() {
        return editable;
    }

    @Override
    public boolean noFuture() {
        return this == FOUND_DATE;
    }

    @Override
    public int maxValue() {
        return this == AGE ? 120 : Integer.MAX_VALUE;
    }
}
