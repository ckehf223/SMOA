package com.smoa.records;

import com.smoa.permission.DistrictKey;
import com.smoa.scope.DistrictScoped;

/**
 * 변경 이력 한 줄. kind 는 출처: STAGE(TGSTGLOG 단계 변경) / STATUS(TGSTATLOG 상태 변경) / CHANGE(CHGLOG 변경 이력).
 * 값은 단계 코드·상태 문자열이며 연락처 원문·암호문·비밀번호는 담지 않는다.
 * effectiveDate/effectiveAt 은 한국(Asia/Seoul) 업무 시각, recordedAt 은 UTC 감사 시각이다(ISO-8601, 끝에 Z).
 */
public record HistoryEntry(
        String id,
        String kind,
        String personId,
        DistrictKey districtKey,
        String type,
        String fromValue,
        String toValue,
        String effectiveDate,
        String effectiveAt,
        boolean timeUnknown,
        boolean baseline,
        String reason,
        String actorAccountId,
        String actorName,
        String recordedAt,
        String action,
        String targetKind,
        String targetId) implements DistrictScoped {

    public static final String KIND_STAGE = "STAGE";
    public static final String KIND_STATUS = "STATUS";
    public static final String KIND_CHANGE = "CHANGE";

    public static final String CREATED = "CREATED";
    public static final String UPDATED = "UPDATED";
    public static final String STAGE_CHANGED = "STAGE_CHANGED";
    public static final String STAGE_BASELINE = "STAGE_BASELINE";
    public static final String DROPPED = "DROPPED";
    public static final String RESTORED = "RESTORED";
    public static final String STATUS_CHANGED = "STATUS_CHANGED";
    public static final String DELETED = "DELETED";
    public static final String UNDELETED = "UNDELETED";
    public static final String PHONE_CHANGED = "PHONE_CHANGED";
    public static final String ACTIVITY_CHANGED = "ACTIVITY_CHANGED";

    /** 단계·상태 로그와 중복되는 CHGLOG 감사 항목(목록에서는 단계/상태 로그 쪽만 보인다). */
    public static boolean duplicatesLifecycleLog(HistoryEntry e) {
        return KIND_CHANGE.equals(e.kind())
                && (STAGE_CHANGED.equals(e.type()) || DROPPED.equals(e.type()) || RESTORED.equals(e.type()));
    }
}
