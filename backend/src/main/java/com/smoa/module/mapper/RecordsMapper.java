package com.smoa.module.mapper;

import java.util.List;
import java.util.Map;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * records 모듈 Mapper: 대상자(TGMSTR)·활동(ACTMSTR)·단계/상태 이력(TGSTGLOG/TGSTATLOG)·변경 이력(CHGLOG)·공통코드·조직원 명부 조회.
 * SQL 은 mapper/module/RecordsMapper.xml. 규칙:
 * <ul>
 *   <li>모든 업무 SQL 은 LIB_ID 조건을 가진다(자료실 간 혼합 금지). libId 는 서버 설정 값이며 요청에서 오지 않는다.</li>
 *   <li>모든 조회·수정에는 구역 범위가 들어간다: scopeAll=true 이면 제한 없음(구역 미지정 행 포함), 아니면
 *       districts((regionCode,districtCode) 쌍 목록)가 OR 로 묶인 괄호 한 덩어리로 AND 조건이 된다. 빈 목록은 0행(1=0).
 *       unassigned=true 는 "ALL 이되 활성 구역만" 범위에서 구역 미지정 행도 보이게 한다(ORG 에서는 항상 false).</li>
 *   <li>목록과 건수는 같은 조건 조각을 쓰고, 건수·요약은 페이지(LIMIT/OFFSET)와 무관한 전체 집합이다.</li>
 *   <li>결과 행은 컬럼 별칭 = API 필드 키인 Map 이다(날짜·시각은 SQL 에서 문자열로 만든다: 시간대 변환 없음).</li>
 *   <li>쓰기 파라미터는 평평한 Map 이며 값은 모두 #{} 바인딩이다(키 목록: RecordsMapper.xml 의 각 statement).</li>
 * </ul>
 */
@Mapper
public interface RecordsMapper {

    /** 설정한 자료실 행(LIB_ID, USE_IND). 없으면 null. 기동 시 존재 확인용. */
    Map<String, Object> selectLibrary(@Param("libId") String libId);

    List<Map<String, Object>> selectCodeItems(@Param("libId") String libId);

    long countEmployee(@Param("employeeId") String employeeId, @Param("scopeAll") boolean scopeAll,
            @Param("districts") List<Map<String, String>> districts, @Param("unassigned") boolean unassigned);

    /** 조직원 명부 검색(인도자 선택지). q 는 이름·구성원 표기코드 부분 일치(null=전체). */
    List<Map<String, Object>> selectEmployees(@Param("q") String q, @Param("limit") int limit,
            @Param("scopeAll") boolean scopeAll, @Param("districts") List<Map<String, String>> districts,
            @Param("unassigned") boolean unassigned);

    long countEmployees(@Param("q") String q, @Param("scopeAll") boolean scopeAll,
            @Param("districts") List<Map<String, String>> districts, @Param("unassigned") boolean unassigned);

    String selectMigrationSourceId(@Param("libId") String libId, @Param("personId") String personId);

    // ---- 대상자 ----

    List<Map<String, Object>> selectPeople(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeAll") boolean scopeAll, @Param("districts") List<Map<String, String>> districts,
            @Param("unassigned") boolean unassigned);

    long countPeople(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeAll") boolean scopeAll, @Param("districts") List<Map<String, String>> districts,
            @Param("unassigned") boolean unassigned);

    Map<String, Object> selectPersonById(@Param("libId") String libId, @Param("id") String id,
            @Param("scopeAll") boolean scopeAll, @Param("districts") List<Map<String, String>> districts,
            @Param("unassigned") boolean unassigned);

    /** 평평한 Map(libId, 필드 키들, sys*). 생성된 TGT_ID 는 "id" 키로 채워진다. */
    int insertPerson(Map<String, Object> row);

    /** 평평한 Map(libId, id, expectedVersion, changed(Set), 필드 키들, phoneChange/phoneEnc/phoneLast4/phoneKeyVer, scopeAll, districts, unassigned, sys*). */
    int updatePerson(Map<String, Object> row);

    /** PHONE_ENC 가 비어 있는 새 행에만 연락처를 붙인다(ROW_VERSION 불변). */
    int attachInitialPhone(Map<String, Object> row);

    // ---- 활동 ----

    List<Map<String, Object>> selectActivities(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeAll") boolean scopeAll, @Param("districts") List<Map<String, String>> districts,
            @Param("unassigned") boolean unassigned);

    long countActivities(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeAll") boolean scopeAll, @Param("districts") List<Map<String, String>> districts,
            @Param("unassigned") boolean unassigned);

    /** personCount/personMinutes/standaloneCount/standaloneMinutes (페이지와 무관한 전체 집계). */
    Map<String, Object> summarizeActivities(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeAll") boolean scopeAll, @Param("districts") List<Map<String, String>> districts,
            @Param("unassigned") boolean unassigned);

    Map<String, Object> selectActivityById(@Param("libId") String libId, @Param("id") String id,
            @Param("scopeAll") boolean scopeAll, @Param("districts") List<Map<String, String>> districts,
            @Param("unassigned") boolean unassigned);

    int insertActivity(Map<String, Object> row);

    int updateActivity(Map<String, Object> row);

    // ---- 이력 ----

    /** 단계·상태·변경 로그 UNION 의 최신순 한 쪽. 필터 키: personId, from, to, kind, limit, offset. */
    List<Map<String, Object>> selectHistory(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeAll") boolean scopeAll, @Param("districts") List<Map<String, String>> districts,
            @Param("unassigned") boolean unassigned);

    long countHistory(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeAll") boolean scopeAll, @Param("districts") List<Map<String, String>> districts,
            @Param("unassigned") boolean unassigned);

    /** TGSTGLOG 전체(기준 행 제외)에서 fromValue/toValue/cnt. 필터 키: from, to, regionCode, districtCode. */
    List<Map<String, Object>> selectStageTransitions(@Param("libId") String libId, @Param("f") Map<String, Object> filters,
            @Param("scopeAll") boolean scopeAll, @Param("districts") List<Map<String, String>> districts,
            @Param("unassigned") boolean unassigned);

    long selectNextStageSeq(@Param("personId") String personId);

    long selectNextStatusSeq(@Param("personId") String personId);

    int insertStageLog(Map<String, Object> row);

    int insertStatusLog(Map<String, Object> row);

    /** CHGLOG 해시 체인 직렬화용: 자료실 행을 잠근다(트랜잭션 끝까지 유지). 잠근 행 수를 돌려준다. */
    List<String> lockLibrary(@Param("libId") String libId);

    /** 자료실의 마지막 CHGLOG(seq, hash). 없으면 null. */
    Map<String, Object> selectLastChangeLog(@Param("libId") String libId);

    int insertChangeLog(Map<String, Object> row);
}
