package com.smoa.records;

import java.util.Arrays;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.stream.Collectors;

/** 활동(ACTMSTR) 필드. 시간/분/인도자(활동자)/종류/메모/세션 표시를 잃지 않는다. */
public enum ActivityField implements RecordField {

    CODE("code", "활동 코드", Type.STRING, 60, false, true),
    DATE("date", "활동일", Type.DATE, 0, true, true),
    START_TIME("startTime", "시작 시각", Type.TIME, 0, false, true),
    END_TIME("endTime", "종료 시각", Type.TIME, 0, false, true),
    MINUTES("minutes", "활동 시간(분)", Type.INT, 0, false, true),
    CLASSIFICATION2("classification2", "분류2", Type.STRING, 20, false, true),
    SESSION_KEY("sessionKey", "세션", Type.STRING, 100, false, true),
    WORKER_ID("workerId", "활동자 ID", Type.STRING, 60, false, true),
    WORKER_CODE("workerCode", "활동자 구성원ID", Type.STRING, 60, false, true),
    WORKER("worker", "활동자 이름", Type.STRING, 100, false, true),
    CLASS_NAME("className", "반", Type.STRING, 60, false, true),
    PLACE("place", "장소", Type.STRING, 200, false, true),
    KIND("type", "활동 종류", Type.STRING, 100, false, true),
    MEMO("memo", "메모", Type.TEXT, 5000, false, true),
    // ---- 서버 전용 ----
    REGION_CODE("regionCode", "지역", Type.STRING, 64, false, false),
    DISTRICT_CODE("districtCode", "구역", Type.STRING, 64, false, false),
    DELETED("deleted", "삭제", Type.BOOL, 0, false, false);

    private static final Map<String, ActivityField> BY_KEY =
            Arrays.stream(values()).collect(Collectors.toUnmodifiableMap(ActivityField::key, Function.identity()));

    private final String key;
    private final String label;
    private final Type type;
    private final int max;
    private final boolean required;
    private final boolean editable;

    ActivityField(String key, String label, Type type, int max, boolean required, boolean editable) {
        this.key = key;
        this.label = label;
        this.type = type;
        this.max = max;
        this.required = required;
        this.editable = editable;
    }

    public static Optional<ActivityField> byKey(String key) {
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
        return this == DATE;
    }

    @Override
    public int maxValue() {
        return this == MINUTES ? 1440 : Integer.MAX_VALUE;
    }
}
