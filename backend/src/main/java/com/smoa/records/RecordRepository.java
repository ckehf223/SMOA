package com.smoa.records;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.smoa.crypto.ContactVault.PhoneSecret;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;

/**
 * 대상자·활동·변경 이력 저장소 계약. 구현은 local-memory 의 {@code MemoryRecordRepository} 와 local/prod 의
 * {@code MyBatisRecordRepository}(RecordsMapper/XML) 두 가지다.
 * <ul>
 *   <li>모든 조회·변경은 서버가 정한 {@link DataScope} 를 받아 구현이 WHERE 에 반영한다(ORG 는 (지역,구역) 쌍 목록, 빈 목록은 0행,
 *       ALL 이 아니면 구역 미지정 행은 보이지 않는다). DB 구현은 추가로 모든 업무 SQL 에 LIB_ID 조건을 둔다.</li>
 *   <li>변경은 {@code expectedVersion}(ROW_VERSION)이 현재와 같을 때만 반영한다. 다르면 {@link Outcome#CONFLICT}.</li>
 *   <li>변경 메서드는 서비스의 하나의 트랜잭션(UnitOfWork) 안에서 호출된다. 현재 행 변경과 이력/CHGLOG 기록은 같이 커밋되거나 같이 롤백된다.</li>
 * </ul>
 */
public interface RecordRepository {

    enum Outcome { OK, NOT_FOUND, CONFLICT }

    record WriteResult<T>(Outcome outcome, T value) {
        public static <T> WriteResult<T> ok(T value) {
            return new WriteResult<>(Outcome.OK, value);
        }

        public static <T> WriteResult<T> of(Outcome outcome) {
            return new WriteResult<>(outcome, null);
        }
    }

    /** 공통코드 한 항목(CODEDTL). */
    record CodeItem(String value, String label, int sortOrder, boolean active) {
    }

    /** 연락처 변경 지시. none=변경 없음, clear=지움, set=새 봉투 저장. */
    record PhoneUpdate(boolean change, PhoneSecret secret) {
        public static final PhoneUpdate NONE = new PhoneUpdate(false, null);
        public static final PhoneUpdate CLEAR = new PhoneUpdate(true, null);

        public static PhoneUpdate set(PhoneSecret secret) {
            return new PhoneUpdate(true, secret);
        }
    }

    record PeopleQuery(String q, String regionCode, String districtCode, String stageId, String status,
            boolean includeDeleted, String phoneLast4, String foundFrom, String foundTo, int limit, int offset) {
    }

    record ActivityQuery(String personId, Boolean standalone, String regionCode, String districtCode, String from,
            String to, int limit, int offset) {
    }

    /** 이력 목록 조건. kind 는 STAGE/STATUS/CHANGE(null=전체), from/to 는 적용일(YYYY-MM-DD) 범위. */
    record HistoryQuery(String personId, String from, String to, String kind, int limit, int offset) {
    }

    record HistoryPage(List<HistoryEntry> items, long total) {
    }

    record StageQuery(String from, String to, String regionCode, String districtCode) {
    }

    record ActivityTotals(long personCount, long personMinutes, long standaloneCount, long standaloneMinutes) {
        public long total() {
            return personCount + standaloneCount;
        }
    }

    /** 인도자 선택지(조직원 명부). 연락처 등 개인 연락 정보는 없다. */
    record EmployeeOption(String id, String code, String name, DistrictKey districtKey) {
    }

    record EmployeePage(List<EmployeeOption> items, long total) {
    }

    // ---- 공통코드/참조 ----

    /** 이 자료실의 공통코드. 그룹 코드 → 항목(정렬 순서). 단계는 STAGE 그룹이다. */
    Map<String, List<CodeItem>> codes();

    /** 허용 범위의 조직원 명부에 이 ID가 있는가. */
    boolean employeeExists(String employeeId, DataScope scope);

    /** 조직원 명부 검색(이름·구성원 표기코드 부분 일치). 구역 범위로 좁히고 구역 미지정은 ALL 만. 이름은 중복될 수 있어 불변 ID 로 선택한다. */
    EmployeePage searchEmployees(String q, DataScope scope, int limit);

    // ---- 대상자 ----

    List<Person> searchPeople(PeopleQuery query, DataScope scope);

    /** searchPeople 과 같은 조건·범위의 전체 건수(limit/offset 무시). */
    long countPeople(PeopleQuery query, DataScope scope);

    /** 삭제된 행도 돌려준다(삭제 여부는 Person.deleted()). 범위 밖이면 empty. */
    Optional<Person> findPerson(String id, DataScope scope);

    /** 새 행을 만든다(PK 는 저장소가 부여, 중복 이름·코드 허용). 연락처는 {@link #attachInitialPhone} 로 따로 붙인다. */
    Person insertPerson(Person person);

    /**
     * 지정한 필드만 바꾼다(나머지 컬럼·SOURCE_ENC·LEGACY_ID 보존). changes 의 null 값은 지움.
     * phone 이 change 이면 연락처도 같은 문장에서 바꾼다. 성공하면 ROW_VERSION 이 1 올라간다.
     */
    WriteResult<Person> updatePerson(String id, Map<PersonField, Object> changes, PhoneUpdate phone,
            long expectedVersion, DataScope scope);

    /** 새 행에 연락처를 처음 붙인다(ROW_VERSION 불변, PHONE_ENC 가 비어 있을 때만). */
    void attachInitialPhone(String id, PhoneSecret secret);

    /** 이 행의 연락처 AAD 를 만들 때 쓸 이관 원본 ID(MIGMAP TGMSTR). 웹에서 만든 행은 empty. */
    Optional<String> migrationSourceId(String personId);

    // ---- 활동 ----

    List<Activity> searchActivities(ActivityQuery query, DataScope scope);

    long countActivities(ActivityQuery query, DataScope scope);

    /** 같은 조건·범위 전체(페이지와 무관)의 대상자 활동·독립 활동 건수와 분 합계. */
    ActivityTotals summarizeActivities(ActivityQuery query, DataScope scope);

    Optional<Activity> findActivity(String id, DataScope scope);

    Activity insertActivity(Activity activity);

    WriteResult<Activity> updateActivity(String id, Map<ActivityField, Object> changes, long expectedVersion,
            DataScope scope);

    // ---- 이력 ----

    /**
     * 이력 한 줄을 남긴다. kind=STAGE → TGSTGLOG, STATUS → TGSTATLOG, CHANGE → CHGLOG(해시 체인).
     * beforeJson/afterJson 은 CHANGE 에만 쓰이며 연락처·비밀번호를 담지 않는다.
     */
    void appendHistory(HistoryEntry entry, String beforeJson, String afterJson);

    /**
     * 범위 안 이력 한 쪽(최신순). 총건수는 같은 조건의 SQL COUNT 이며 페이지 크기와 무관하다.
     * 단계·상태 로그와 중복되는 CHGLOG 감사 항목은 제외한다.
     */
    HistoryPage history(HistoryQuery query, DataScope scope);

    /** 단계 이동 집계: TGSTGLOG 전체(기준 행 제외)에서 (이전→이후)별 건수. 목록 페이지·CHGLOG 와 무관하다. */
    Map<String, Long> stageTransitions(StageQuery query, DataScope scope);
}
