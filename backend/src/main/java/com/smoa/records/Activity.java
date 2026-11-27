package com.smoa.records;

import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;

import com.smoa.permission.DistrictKey;
import com.smoa.scope.DistrictScoped;

/**
 * 활동 기록(ACTMSTR). {@code personId} 가 null 이면 대상자에 속하지 않는 독립 활동이다(원본 이관 2253건 포함).
 * 구역은 활동 행 자신의 (지역+구역)이며, 구역이 없으면 ALL 범위에서만 보인다.
 */
public final class Activity implements DistrictScoped {

    private final String id;
    private final String personId;
    private final String legacyId;
    private final Map<ActivityField, Object> values;
    private final long rowVersion;
    private final String createdAt;
    private final String updatedAt;

    public Activity(String id, String personId, String legacyId, Map<ActivityField, Object> values, long rowVersion,
            String createdAt, String updatedAt) {
        this.id = id;
        this.personId = personId;
        this.legacyId = legacyId;
        EnumMap<ActivityField, Object> copy = new EnumMap<>(ActivityField.class);
        values.forEach((k, v) -> {
            if (v != null) {
                copy.put(k, v);
            }
        });
        this.values = Collections.unmodifiableMap(copy);
        this.rowVersion = rowVersion;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    public String id() {
        return id;
    }

    /** 대상자 TGT_ID 문자열. 독립 활동은 null (NPE 를 피하려면 {@link #standalone()} 로 먼저 구분한다). */
    public String personId() {
        return personId;
    }

    public boolean standalone() {
        return personId == null;
    }

    public String legacyId() {
        return legacyId;
    }

    public Map<ActivityField, Object> values() {
        return values;
    }

    public long rowVersion() {
        return rowVersion;
    }

    public String createdAt() {
        return createdAt;
    }

    public String updatedAt() {
        return updatedAt;
    }

    public String str(ActivityField field) {
        Object v = values.get(field);
        return v == null ? null : v.toString();
    }

    public String date() {
        return str(ActivityField.DATE);
    }

    public int minutes() {
        Object v = values.get(ActivityField.MINUTES);
        return v instanceof Number n ? n.intValue() : 0;
    }

    public boolean deleted() {
        return Boolean.TRUE.equals(values.get(ActivityField.DELETED));
    }

    @Override
    public DistrictKey districtKey() {
        String region = str(ActivityField.REGION_CODE);
        String district = str(ActivityField.DISTRICT_CODE);
        return DistrictKey.valid(region, district) ? new DistrictKey(region, district) : null;
    }

    public Activity with(Map<ActivityField, Object> changes) {
        EnumMap<ActivityField, Object> next = new EnumMap<>(ActivityField.class);
        next.putAll(values);
        changes.forEach((k, v) -> {
            if (v == null) {
                next.remove(k);
            } else {
                next.put(k, v);
            }
        });
        return new Activity(id, personId, legacyId, next, rowVersion, createdAt, updatedAt);
    }

    public Activity withMeta(String newId, long newRowVersion, String newCreatedAt, String newUpdatedAt) {
        return new Activity(newId, personId, legacyId, values, newRowVersion, newCreatedAt, newUpdatedAt);
    }

    @Override
    public String toString() {
        return "Activity[id=" + id + "]";
    }
}
