package com.smoa.records;

import java.util.EnumMap;
import java.util.Map;

import com.smoa.permission.DistrictKey;
import com.smoa.scope.DistrictScoped;

/**
 * 대상자(TGMSTR). id 는 TGT_ID(AUTO_INCREMENT bigint)의 문자열 표현이다(원본 UUID·MIGMAP 원본 ID 는 PK 가 아니다).
 * 값은 {@link PersonField} 로 정의된 정규화 값 맵이다(없는 값은 키 없음). 연락처 원문·암호문은 이 모델에 없고
 * 끝 네 자리({@code phoneLast4})와 보유 여부({@code hasPhone})만 있다. 중복 이름·코드·연락처·LEGACY_ID 를 허용한다.
 */
public final class Person implements DistrictScoped {

    public static final String ACTIVE = "active";
    public static final String DROPPED = "dropped";

    private final String id;
    private final String legacyId;
    private final Map<PersonField, Object> values;
    private final String phoneLast4;
    private final boolean hasPhone;
    private final long rowVersion;
    private final String createdAt;
    private final String updatedAt;

    public Person(String id, String legacyId, Map<PersonField, Object> values, String phoneLast4, boolean hasPhone,
            long rowVersion, String createdAt, String updatedAt) {
        this.id = id;
        this.legacyId = legacyId;
        EnumMap<PersonField, Object> copy = new EnumMap<>(PersonField.class);
        values.forEach((k, v) -> {
            if (v != null) {
                copy.put(k, v);
            }
        });
        this.values = java.util.Collections.unmodifiableMap(copy);
        this.phoneLast4 = phoneLast4;
        this.hasPhone = hasPhone;
        this.rowVersion = rowVersion;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    public String id() {
        return id;
    }

    public String legacyId() {
        return legacyId;
    }

    public Map<PersonField, Object> values() {
        return values;
    }

    public String phoneLast4() {
        return phoneLast4;
    }

    public boolean hasPhone() {
        return hasPhone;
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

    public String str(PersonField field) {
        Object v = values.get(field);
        return v == null ? null : v.toString();
    }

    public String name() {
        return str(PersonField.NAME);
    }

    public String code() {
        return str(PersonField.CODE);
    }

    public String stageId() {
        return str(PersonField.STAGE);
    }

    public String status() {
        return str(PersonField.STATUS);
    }

    public boolean deleted() {
        return Boolean.TRUE.equals(values.get(PersonField.DELETED));
    }

    /** 현재 구역. 지역·구역 코드가 비었거나 형식이 올바르지 않으면 null(= 구역 미지정, ALL 범위에서만 보인다). */
    @Override
    public DistrictKey districtKey() {
        String region = str(PersonField.REGION_CODE);
        String district = str(PersonField.DISTRICT_CODE);
        return DistrictKey.valid(region, district) ? new DistrictKey(region, district) : null;
    }

    /** changes 를 적용한 새 사본(값이 null 이면 해당 필드를 지운다). */
    public Person with(Map<PersonField, Object> changes) {
        EnumMap<PersonField, Object> next = new EnumMap<>(PersonField.class);
        next.putAll(values);
        changes.forEach((k, v) -> {
            if (v == null) {
                next.remove(k);
            } else {
                next.put(k, v);
            }
        });
        return new Person(id, legacyId, next, phoneLast4, hasPhone, rowVersion, createdAt, updatedAt);
    }

    public Person withPhone(String last4, boolean has) {
        return new Person(id, legacyId, values, last4, has, rowVersion, createdAt, updatedAt);
    }

    public Person withMeta(String newId, long newRowVersion, String newCreatedAt, String newUpdatedAt) {
        return new Person(newId, legacyId, values, phoneLast4, hasPhone, newRowVersion, newCreatedAt, newUpdatedAt);
    }

    @Override
    public String toString() {
        return "Person[id=" + id + "]";
    }
}
