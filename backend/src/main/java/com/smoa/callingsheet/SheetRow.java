package com.smoa.callingsheet;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import com.smoa.permission.DistrictKey;

/**
 * 콜링시트 한 행(CALLSHEET + 회차). 날짜는 문자열(yyyy-MM-dd, yyyy-MM-ddTHH:mm:ss)로 다룬다(시간대 변환 없음, 원문 나이는 변환하지 않음).
 * 연락처 원문·암호문은 이 모델에 없고 끝 네 자리와 보유 여부만 있다. sourceEnc 는 전화번호 형태 문자열의 봉인 보존본이며
 * 서버 내부에서만 쓰고 어떤 응답·로그에도 나가지 않는다(toString 포함).
 */
public record SheetRow(
        long id,
        Long targetId,
        String callStatus,
        String foundDate,
        String callResult,
        String targetName,
        String introducerId,
        String introducerName,
        String regionCode,
        String districtCode,
        String sexCode,
        String ageText,
        String residence,
        String preferredPlace,
        String notes,
        String consultTopic,
        String manpikConfirmedAt,
        String manpikInfo,
        String assignedUserId,
        String assignedUserName,
        String phoneLast4,
        List<RoundEntry> rounds,
        long rowVersion,
        boolean deleted,
        String createdAt,
        String updatedAt,
        String sourceEnc) {

    public SheetRow {
        rounds = rounds == null ? List.of()
                : rounds.stream().sorted((a, b) -> RoundEntry.compareCodes(a.code(), b.code())).toList();
    }

    public boolean hasPhone() {
        return phoneLast4 != null;
    }

    /** 구역 키. 지역·구역이 모두 있을 때만 값이 있다(없으면 구역 미지정). */
    public DistrictKey districtKey() {
        return regionCode != null && districtCode != null && DistrictKey.valid(regionCode, districtCode)
                ? new DistrictKey(regionCode, districtCode)
                : null;
    }

    public Object value(SheetField field) {
        return switch (field) {
            case TARGET_ID -> targetId;
            case CALL_STATUS -> callStatus;
            case FOUND_DATE -> foundDate;
            case CALL_RESULT -> callResult;
            case TARGET_NAME -> targetName;
            case INTRO_EMPL_ID -> introducerId;
            case INTRO_NAME -> introducerName;
            case REGION_CODE -> regionCode;
            case DISTRICT_CODE -> districtCode;
            case SEX_CODE -> sexCode;
            case AGE_TEXT -> ageText;
            case RESIDENCE -> residence;
            case PREFERRED_PLACE -> preferredPlace;
            case NOTES -> notes;
            case CONSULT_TOPIC -> consultTopic;
            case MANPIK_CONFIRMED_AT -> manpikConfirmedAt;
            case MANPIK_INFO -> manpikInfo;
            case ASSIGNED_USER_ID -> assignedUserId;
            case ASSIGNED_USER_NAME -> assignedUserName;
        };
    }

    /** 일부 필드·회차·연락처 끝자리·봉인본만 바꾼 새 행. changes 에 없는 필드는 보존, 값이 null 이면 지움. */
    public SheetRow with(Map<SheetField, Object> changes, List<RoundEntry> newRounds, boolean phoneChange,
            String newLast4, boolean sourceChange, String newSourceEnc, long newVersion, String updated) {
        Function<SheetField, Object> v = f -> changes.containsKey(f) ? changes.get(f) : value(f);
        return new SheetRow(id, (Long) v.apply(SheetField.TARGET_ID), (String) v.apply(SheetField.CALL_STATUS),
                (String) v.apply(SheetField.FOUND_DATE), (String) v.apply(SheetField.CALL_RESULT),
                (String) v.apply(SheetField.TARGET_NAME), (String) v.apply(SheetField.INTRO_EMPL_ID),
                (String) v.apply(SheetField.INTRO_NAME), (String) v.apply(SheetField.REGION_CODE),
                (String) v.apply(SheetField.DISTRICT_CODE), (String) v.apply(SheetField.SEX_CODE),
                (String) v.apply(SheetField.AGE_TEXT), (String) v.apply(SheetField.RESIDENCE),
                (String) v.apply(SheetField.PREFERRED_PLACE), (String) v.apply(SheetField.NOTES),
                (String) v.apply(SheetField.CONSULT_TOPIC), (String) v.apply(SheetField.MANPIK_CONFIRMED_AT),
                (String) v.apply(SheetField.MANPIK_INFO), (String) v.apply(SheetField.ASSIGNED_USER_ID),
                (String) v.apply(SheetField.ASSIGNED_USER_NAME), phoneChange ? newLast4 : phoneLast4,
                newRounds == null ? rounds : new ArrayList<>(newRounds), newVersion, deleted, createdAt, updated,
                sourceChange ? newSourceEnc : sourceEnc);
    }

    public SheetRow withDeleted(boolean value, long newVersion, String updated) {
        return new SheetRow(id, targetId, callStatus, foundDate, callResult, targetName, introducerId, introducerName,
                regionCode, districtCode, sexCode, ageText, residence, preferredPlace, notes, consultTopic,
                manpikConfirmedAt, manpikInfo, assignedUserId, assignedUserName, phoneLast4, rounds, newVersion, value,
                createdAt, updated, sourceEnc);
    }

    @Override
    public String toString() {
        return "SheetRow[id=" + id + ", rowVersion=" + rowVersion + "]";
    }
}
