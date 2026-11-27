package com.smoa.callingsheet;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Set;

/**
 * 목록·차트·내보내기가 함께 쓰는 필터(서비스가 검증·정규화한 값). 같은 SheetQuery 는 같은 행 집합을 뜻한다(페이지 크기 제외).
 * assigned/manpik/roundState 는 "any"|"none"|null. 정렬은 SORT_KEYS 허용 목록의 키만 쓴다.
 */
public record SheetQuery(
        String q,
        String regionCode,
        String districtCode,
        String callStatus,
        String callResult,
        LocalDate foundFrom,
        LocalDate foundTo,
        LocalDate createdFrom,
        String assignedUserId,
        String assigned,
        String manpik,
        String roundCode,
        String roundState,
        String phoneLast4,
        boolean trash,
        String sort,
        boolean desc,
        int offset,
        int size) {

    public static final Set<String> SORT_KEYS = Set.of("id", "foundDate", "callStatus", "callResult", "targetName",
            "introducerName", "district", "manpikConfirmedAt", "assignedUserName", "createdAt", "updatedAt");
    public static final int MAX_SIZE = 200;
    public static final int MAX_EXPORT_ROWS = 20000;

    public LocalDateTime createdFromUtc() {
        return createdFrom == null ? null : createdFrom.atStartOfDay(ZoneId.of("Asia/Seoul"))
                .withZoneSameInstant(ZoneOffset.UTC).toLocalDateTime();
    }

    /** 페이지 조건만 바꾼 복사본. */
    public SheetQuery withPage(int newOffset, int newSize) {
        return new SheetQuery(q, regionCode, districtCode, callStatus, callResult, foundFrom, foundTo, createdFrom,
                assignedUserId, assigned, manpik, roundCode, roundState, phoneLast4, trash, sort, desc, newOffset,
                newSize);
    }
}
