package com.smoa.callingsheet.persistence;

import java.util.List;
import java.util.Map;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * 콜링시트 Mapper(CALLSHEET·CALLSHEETROUND, 기존 CHGLOG/LIBMSTR/TGMSTR/PSMSTR 읽기). SQL 은 mapper/callingsheet/CallingSheetMapper.xml.
 * 규칙(기존 RecordsMapper 와 같음):
 * <ul>
 *   <li>모든 업무 SQL 은 LIB_ID 조건을 가진다. libId 는 서버 설정 값이며 요청에서 오지 않는다.</li>
 *   <li>모든 조회·수정에는 서비스가 계산한 구역 범위가 들어간다: scopeUnassigned=true 이면 구역 미지정 행 포함, districts 는
 *       (regionCode,districtCode) 쌍 목록이 OR 괄호 한 덩어리로 AND 조건이 된다. 둘 다 비면 1 = 0(0행).</li>
 *   <li>결과 행은 컬럼 별칭 = API 키인 Map 이다(날짜·시각은 SQL 에서 문자열로 만든다). PHONE_ENC 는 어떤 SELECT 에서도 읽지 않는다.</li>
 *   <li>쓰기 파라미터는 평평한 Map 이며 값은 모두 #{} 바인딩이다. ORDER BY 는 허용 키의 choose 로만 고른다(${} 사용자 값 없음).</li>
 * </ul>
 */
@Mapper
public interface CallingSheetMapper {

    // ---- 조회 ----

    List<Map<String, Object>> selectSheets(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeUnassigned") boolean scopeUnassigned, @Param("districts") List<Map<String, String>> districts,
            @Param("offset") int offset, @Param("limit") int limit);

    long countSheets(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeUnassigned") boolean scopeUnassigned, @Param("districts") List<Map<String, String>> districts);

    /** 범위 안 단건(SOURCE_ENC 포함: 서버 내부 병합용). includeDeleted 가 아니면 삭제된 행은 없다. */
    Map<String, Object> selectSheetById(@Param("libId") String libId, @Param("id") long id,
            @Param("includeDeleted") boolean includeDeleted, @Param("scopeUnassigned") boolean scopeUnassigned,
            @Param("districts") List<Map<String, String>> districts);

    /** 방금 쓴 행을 다시 읽는다(서비스가 범위를 이미 검증한 쓰기 직후에만 사용). */
    Map<String, Object> selectSheetAfterWrite(@Param("libId") String libId, @Param("id") long id);

    List<Map<String, Object>> selectRounds(@Param("libId") String libId, @Param("ids") List<Long> ids);

    List<String> selectDistinctStatuses(@Param("libId") String libId, @Param("scopeUnassigned") boolean scopeUnassigned,
            @Param("districts") List<Map<String, String>> districts, @Param("limit") int limit);

    List<String> selectDistinctResults(@Param("libId") String libId, @Param("scopeUnassigned") boolean scopeUnassigned,
            @Param("districts") List<Map<String, String>> districts, @Param("limit") int limit);

    // ---- 집계(목록과 같은 필터·범위) ----

    Map<String, Object> selectStatsSummary(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeUnassigned") boolean scopeUnassigned, @Param("districts") List<Map<String, String>> districts);

    List<Map<String, Object>> selectStatsByStatus(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeUnassigned") boolean scopeUnassigned, @Param("districts") List<Map<String, String>> districts);

    List<Map<String, Object>> selectStatsByResult(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeUnassigned") boolean scopeUnassigned, @Param("districts") List<Map<String, String>> districts);

    List<Map<String, Object>> selectStatsByDistrict(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeUnassigned") boolean scopeUnassigned, @Param("districts") List<Map<String, String>> districts);

    // ---- 선택지(범위 안 최소 정보) ----

    long countTargetVisible(@Param("libId") String libId, @Param("id") long id,
            @Param("scopeUnassigned") boolean scopeUnassigned, @Param("districts") List<Map<String, String>> districts);

    List<Map<String, Object>> selectTargets(@Param("libId") String libId, @Param("qLike") String qLike,
            @Param("scopeUnassigned") boolean scopeUnassigned, @Param("districts") List<Map<String, String>> districts,
            @Param("limit") int limit);

    List<Map<String, Object>> selectMembers(@Param("qLike") String qLike,
            @Param("scopeUnassigned") boolean scopeUnassigned, @Param("districts") List<Map<String, String>> districts,
            @Param("limit") int limit);

    long countMember(@Param("employeeId") String employeeId, @Param("scopeUnassigned") boolean scopeUnassigned,
            @Param("districts") List<Map<String, String>> districts);

    // ---- 쓰기(평평한 Map) ----

    /** libId, 필드 키들, sys*. 생성된 SHEET_ID 는 "id" 키로 채워진다. */
    int insertSheet(Map<String, Object> row);

    /** id, libId, phoneEnc/phoneLast4/phoneKeyVer, sourceEnc. ROW_VERSION 불변. */
    int attachSecrets(Map<String, Object> row);

    /**
     * libId, id, expectedVersion, changed(Set 키), 필드 키들, phoneChange/phoneEnc/phoneLast4/phoneKeyVer, sourceChange/sourceEnc,
     * scopeUnassigned, districts, sys*. 항상 ROW_VERSION 을 1 올린다. 0행이면 없음 또는 버전 충돌.
     */
    int updateSheet(Map<String, Object> row);

    /** libId, id, expectedVersion, fromInd, toInd, scopeUnassigned, districts, sys*. */
    int updateDeleted(Map<String, Object> row);

    int upsertRound(Map<String, Object> row);

    int deleteRound(@Param("libId") String libId, @Param("sheetId") long sheetId, @Param("code") String code);

    /** 최신 변경이력의 현재 버전. 반드시 자료실 잠금을 잡은 뒤 호출한다. */
    Map<String, Object> selectLastChangeLogForUpdate(@Param("libId") String libId);
}
