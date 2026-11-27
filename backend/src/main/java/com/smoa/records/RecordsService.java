package com.smoa.records;

import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.Collections;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.smoa.access.AccessGrant;
import com.smoa.account.UnitOfWork;
import com.smoa.common.ApiException;
import com.smoa.config.LibraryContext;
import com.smoa.crypto.ContactVault;
import com.smoa.crypto.ContactVault.PhoneSecret;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.records.RecordRepository.ActivityQuery;
import com.smoa.records.RecordRepository.CodeItem;
import com.smoa.records.RecordRepository.Outcome;
import com.smoa.records.RecordRepository.PeopleQuery;
import com.smoa.records.RecordRepository.PhoneUpdate;
import com.smoa.records.RecordRepository.WriteResult;
import com.smoa.scope.ScopeEnforcer;

/**
 * 대상자·활동·변경 이력 업무 규칙. 모든 읽기·쓰기는 서버가 정한 구역 범위(AccessGrant)로 SQL 과 서비스에서 이중 검사하고,
 * 현재 행 변경 + 단계/상태 이력 + CHGLOG 는 한 트랜잭션(UnitOfWork)으로 묶는다.
 *
 * <h3>수정 규칙(부분 수정)</h3>
 * 요청 본문에 <b>있는 필드만</b> 바꾼다. 없는 필드는 그대로이며(다른 컬럼·SOURCE_ENC·LEGACY_ID 도 보존),
 * 값이 {@code null} 이거나 빈 문자열이면 그 필드를 비운다(필수 필드는 400). 수정에는 읽을 때 받은 {@code rowVersion} 이 필요하고,
 * 다른 사람이 먼저 저장했다면 409 VERSION_CONFLICT 이다. 단계·상태·삭제·연락처는 전용 경로로만 바꾼다.
 */
@Service
public class RecordsService {

    /** 호환용 /items 배열 API 의 기본·최대 행 수. 전체는 X-Total-Count 로 알리며, 화면은 /page 로 이전/다음 조회한다. */
    public static final int DEFAULT_LIMIT = 2000;
    public static final int MAX_LIMIT = 5000;
    /** /page API 의 기본·최대 페이지 크기. 총건수·집계는 이 값과 무관하게 SQL 이 전체에서 계산한다. */
    public static final int PAGE_DEFAULT = 50;
    public static final int PAGE_MAX = 200;
    /** 내보내기는 이 크기로 끝까지 나눠 읽는다(페이지 제한 때문에 행이 빠지지 않는다). */
    static final int EXPORT_CHUNK = 1000;
    public static final String STAGE_GROUP = "STAGE";

    private static final Pattern CODE = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_-]{2,59}");
    private static final Pattern FOUR_DIGITS = Pattern.compile("\\d{4}");
    private static final Pattern PHONE_IN_TEXT =
            Pattern.compile("(?:\\+82[- .]?)?0?1[016789][- .]?\\d{3,4}[- .]?\\d{4}");
    private static final ObjectMapper JSON = new ObjectMapper();

    /** 목록 조건. limit/offset 이 0 이하이면 기본값. */
    public record PersonFilter(String regionCode, String districtCode, String stageId, String status, String q,
            boolean includeDeleted, String phoneLast4, String foundFrom, String foundTo, int limit, int offset) {
    }

    public record ActivityFilter(String personId, Boolean standalone, String regionCode, String districtCode,
            String from, String to, int limit, int offset) {
    }

    public record HistoryFilter(String personId, String from, String to, String kind, int limit, int offset) {
    }

    /** 한 쪽 결과. total 은 같은 조건 전체 건수(SQL COUNT), limit/offset 은 실제 적용한 값. */
    public record Page<T>(List<T> items, long total, int limit, int offset) {
    }

    private final RecordRepository repository;
    private final ScopeEnforcer enforcer;
    private final ContactVault vault;
    private final UnitOfWork unitOfWork;
    private final ObjectProvider<LibraryContext> library;

    public RecordsService(RecordRepository repository, ScopeEnforcer enforcer, ContactVault vault,
            UnitOfWork unitOfWork, ObjectProvider<LibraryContext> library) {
        this.repository = repository;
        this.enforcer = enforcer;
        this.vault = vault;
        this.unitOfWork = unitOfWork;
        this.library = library;
    }

    // ================= 옵션 =================

    /** 화면 선택지: 공통코드(단계 포함)와 상태. 구역 선택지는 컨트롤러가 범위 안 활성 구역으로 좁힌다. */
    public Map<String, Object> options() {
        Map<String, List<CodeItem>> codes = repository.codes();
        List<CodeItem> stages = codes.getOrDefault(STAGE_GROUP, List.of());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("stages", stages.stream().filter(CodeItem::active).map(CodeItem::value).toList());
        result.put("stageItems", stages.stream().map(s -> codeView(s)).toList());
        result.put("statuses", List.of(Person.ACTIVE, Person.DROPPED));
        Map<String, Object> others = new LinkedHashMap<>();
        codes.forEach((group, items) -> {
            if (!STAGE_GROUP.equals(group)) {
                others.put(group, items.stream().map(RecordsService::codeView).toList());
            }
        });
        result.put("codes", others);
        return result;
    }

    private static Map<String, Object> codeView(CodeItem item) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("value", item.value());
        m.put("label", item.label());
        m.put("active", item.active());
        return m;
    }

    // ================= 대상자 =================

    /** 이전/다음 조회용 한 쪽(기본 50, 최대 200). */
    public Page<Person> pagePeople(AccessGrant grant, PersonFilter filter) {
        return queryPeople(grant, filter, PAGE_DEFAULT, PAGE_MAX);
    }

    /** 호환용 배열 API(기본 2000, 최대 5000). 전체 건수는 Page.total 로 알 수 있다. */
    public Page<Person> listPeople(AccessGrant grant, PersonFilter filter) {
        return queryPeople(grant, filter, DEFAULT_LIMIT, MAX_LIMIT);
    }

    private Page<Person> queryPeople(AccessGrant grant, PersonFilter filter, int defaultLimit, int maxLimit) {
        int limit = limit(filter.limit(), defaultLimit, maxLimit);
        int offset = Math.max(0, filter.offset());
        DataScope scope = enforcer.effectiveScope(grant);
        PeopleQuery query = peopleQuery(filter, limit, offset);   // 입력 검증은 범위와 무관하게 먼저
        if (scope.isEmptyAssignment()) {
            return new Page<>(List.of(), 0, limit, offset);
        }
        long total = repository.countPeople(query, scope);
        List<Person> rows = total == 0 || offset >= total ? List.of() : repository.searchPeople(query, scope);
        return new Page<>(rows, total, limit, offset);
    }

    private PeopleQuery peopleQuery(PersonFilter filter, int limit, int offset) {
        String phoneLast4 = blankToNull(filter.phoneLast4());
        if (phoneLast4 != null && !FOUR_DIGITS.matcher(phoneLast4).matches()) {
            throw bad("연락처 검색: 끝 네 자리 숫자만 입력할 수 있습니다.");
        }
        String from = optionalDate(filter.foundFrom(), "찾은 날짜(시작)");
        String to = optionalDate(filter.foundTo(), "찾은 날짜(끝)");
        return new PeopleQuery(blankToNull(filter.q()), blankToNull(filter.regionCode()),
                blankToNull(filter.districtCode()), blankToNull(filter.stageId()), blankToNull(filter.status()),
                filter.includeDeleted(), phoneLast4, from, to, limit, offset);
    }

    /**
     * 내보내기용: 화면과 같은 조건(q·단계·상태·구역·찾은 날짜·삭제 포함)·같은 범위로 <b>전체 결과</b>를 나눠 읽는다.
     * 페이지 크기·limit/offset 은 무시하며 한 쪽 제한 때문에 행이 빠지지 않는다.
     */
    public List<Person> exportPeople(AccessGrant grant, PersonFilter filter) {
        DataScope scope = enforcer.effectiveScope(grant);
        PeopleQuery base = peopleQuery(filter, EXPORT_CHUNK, 0);
        if (scope.isEmptyAssignment()) {
            return List.of();
        }
        long total = repository.countPeople(base, scope);
        List<Person> all = new java.util.ArrayList<>();
        for (int offset = 0; offset < total; offset += EXPORT_CHUNK) {
            List<Person> chunk = repository.searchPeople(peopleQuery(filter, EXPORT_CHUNK, offset), scope);
            all.addAll(chunk);
            if (chunk.isEmpty()) {
                break;
            }
        }
        return all;
    }

    /**
     * 인도자 선택지: 서버가 정한 구역 범위로 좁힌 조직원 명부(이름·구성원 표기코드·소속). 이름은 중복될 수 있으므로 화면은 불변 ID 로 고른다.
     * people 프로그램 읽기 권한 안에서만 제공되며 연락처 정보는 없다. 길면 검색어와 페이지 크기로 좁힌다.
     */
    public RecordRepository.EmployeePage introducers(AccessGrant grant, String q, int limit) {
        DataScope scope = enforcer.effectiveScope(grant);
        return repository.searchEmployees(blankToNull(q), scope, limit(limit, 30, 100));
    }

    public Person getPerson(AccessGrant grant, String id) {
        return repository.findPerson(id, enforcer.effectiveScope(grant)).filter(p -> enforcer.visible(grant, p.districtKey()))
                .orElseThrow(RecordsService::notFound);
    }

    public Person createPerson(AccessGrant grant, Map<String, Object> body) {
        Map<String, Object> input = new LinkedHashMap<>(body);
        Object phone = input.remove("phone");
        input.remove("rowVersion");
        Map<PersonField, Object> values = parsePersonFields(input, true);
        DistrictKey district = requireDistrict(input);
        if (!enforcer.visible(grant, district)) {
            throw outOfScope();
        }
        values.put(PersonField.REGION_CODE, district.regionCode());
        values.put(PersonField.DISTRICT_CODE, district.districtCode());
        values.putIfAbsent(PersonField.GENDER, "미상");
        values.put(PersonField.STAGE, requireActiveStage(input.get("stageId")));
        values.put(PersonField.STATUS, Person.ACTIVE);
        values.put(PersonField.DELETED, Boolean.FALSE);
        if (values.get(PersonField.FOUND_DATE) == null && !Boolean.TRUE.equals(values.get(PersonField.DATE_UNKNOWN))) {
            values.put(PersonField.FOUND_DATE, LocalDate.now(FieldValidator.SEOUL).toString());
        }
        checkIntroducer(grant, values);
        String phoneValue = phone == null || phone.toString().isBlank() ? null : phone.toString();
        if (phoneValue != null) {
            ContactVault.digitsOf(phoneValue);   // 키 설정 여부와 무관하게 형식 오류를 먼저 400 으로
        }
        AuditActor actor = AuditActor.of(grant);
        return unitOfWork.execute(() -> {
            Person saved = repository.insertPerson(new Person(null, null, values, null, false, 0, null, null));
            if (phoneValue != null) {
                PhoneSecret secret = vault.seal(phoneValue, ContactVault.newAad(libraryId(), saved.id()));
                repository.attachInitialPhone(saved.id(), secret);
                saved = repository.findPerson(saved.id(), DataScope.all()).orElseThrow();
            }
            String day = today();
            repository.appendHistory(stageEntry(saved, null, saved.stageId(), day, null, true, actor, null), null, null);
            repository.appendHistory(changeEntry(saved, HistoryEntry.CREATED, null, null, day, null, actor),
                    null, afterJson(values));
            return saved;
        });
    }

    public Person updatePerson(AccessGrant grant, String id, Map<String, Object> body) {
        // 범위 밖/없음/삭제됨은 입력 검증보다 먼저 404 로 처리한다(존재 여부를 알리지 않는다).
        Person current = getPerson(grant, id);
        requireLive(current);
        Map<String, Object> input = new LinkedHashMap<>(body);
        long version = requireVersion(input.remove("rowVersion"));
        for (String forbidden : List.of("phone", "stageId", "status", "deleted")) {
            if (input.containsKey(forbidden)) {
                throw bad("'" + forbidden + "' 는 이 요청으로 바꿀 수 없습니다(연락처·단계·상태·삭제는 전용 기능 사용).");
            }
        }
        Map<PersonField, Object> changes = parsePersonFields(input, false);
        boolean hasRegion = input.containsKey("regionCode");
        boolean hasDistrict = input.containsKey("districtCode");
        if (hasRegion != hasDistrict) {
            throw bad("지역·구역: 지역 코드와 구역 코드를 함께 보내 주세요.");
        }
        if (hasRegion) {
            DistrictKey district = requireDistrict(input);
            if (!enforcer.visible(grant, district)) {
                throw outOfScope();
            }
            changes.put(PersonField.REGION_CODE, district.regionCode());
            changes.put(PersonField.DISTRICT_CODE, district.districtCode());
        }
        // 실제로 값이 달라지는 필드만 남긴다(변경 없는 요청은 버전·이력을 올리지 않는다).
        Map<PersonField, Object> effective = new EnumMap<>(PersonField.class);
        changes.forEach((k, v) -> {
            if (!Objects.equals(current.values().get(k), v)) {
                effective.put(k, v);
            }
        });
        if (current.rowVersion() != version) {
            throw versionConflict();
        }
        checkIntroducer(grant, effective);
        if (effective.isEmpty()) {
            return current;
        }
        AuditActor actor = AuditActor.of(grant);
        return unitOfWork.execute(() -> {
            Person saved = write(grant, id, effective, PhoneUpdate.NONE, version);
            repository.appendHistory(changeEntry(saved, HistoryEntry.UPDATED, null, null, today(), null, actor),
                    beforeJson(current, effective.keySet()), afterJson(effective));
            return saved;
        });
    }

    /** 연락처 설정/지움. 원문은 서버에서 AES-256-GCM 으로 봉인해 저장하고, 응답·이력·로그에는 남기지 않는다. */
    public Person setPhone(AccessGrant grant, String id, Map<String, Object> body) {
        Person current = getPerson(grant, id);
        requireLive(current);
        if (!Set.of("phone", "rowVersion").containsAll(body.keySet())) {
            throw bad("허용되지 않은 필드가 있습니다(phone, rowVersion 만 사용).");
        }
        long version = requireVersion(body.get("rowVersion"));
        Object raw = body.get("phone");
        String phone = raw == null || raw.toString().isBlank() ? null : raw.toString();
        if (current.rowVersion() != version) {
            throw versionConflict();
        }
        PhoneUpdate update;
        if (phone == null) {
            update = PhoneUpdate.CLEAR;
        } else {
            ContactVault.digitsOf(phone);
            update = PhoneUpdate.set(vault.seal(phone, ContactVault.newAad(libraryId(), id)));
        }
        AuditActor actor = AuditActor.of(grant);
        String after = phone == null ? "{\"phone\":\"cleared\"}" : "{\"phone\":\"changed\"}";
        return unitOfWork.execute(() -> {
            Person saved = write(grant, id, Map.of(), update, version);
            repository.appendHistory(changeEntry(saved, HistoryEntry.PHONE_CHANGED, null, null, today(), null, actor),
                    null, after);
            return saved;
        });
    }

    public Person changeStage(AccessGrant grant, String id, String stageId, String effectiveDate, String effectiveTime,
            String reason, Object rowVersion) {
        Person current = getPerson(grant, id);
        requireLive(current);
        long version = requireVersion(rowVersion);
        String stage = requireActiveStage(stageId);
        if (stage.equals(current.stageId())) {
            throw bad("현재와 같은 단계입니다.");
        }
        String day = dateOrToday(effectiveDate, "적용일");
        String time = FieldValidator.canonicalTime(blankToNull(effectiveTime));
        if (blankToNull(effectiveTime) != null && time == null) {
            throw bad("적용 시각: HH:mm 형식으로 입력해 주세요.");
        }
        String why = text(reason, "사유", 2000);
        checkVersion(current, version);
        AuditActor actor = AuditActor.of(grant);
        return unitOfWork.execute(() -> {
            Person saved = write(grant, id, Map.of(PersonField.STAGE, stage), PhoneUpdate.NONE, version);
            repository.appendHistory(stageEntry(saved, current.stageId(), stage, day, time, false, actor, why), null, null);
            repository.appendHistory(changeEntry(saved, HistoryEntry.STAGE_CHANGED, current.stageId(), stage, day, why, actor),
                    null, null);
            return saved;
        });
    }

    public Person dropout(AccessGrant grant, String id, String effectiveDate, String reason, Object rowVersion) {
        Person current = getPerson(grant, id);
        requireLive(current);
        long version = requireVersion(rowVersion);
        checkVersion(current, version);
        if (Person.DROPPED.equals(current.status())) {
            throw ApiException.conflict("ALREADY_DROPPED", "이미 탈락 처리된 대상자입니다.");
        }
        return changeStatus(grant, current, Person.DROPPED, HistoryEntry.DROPPED, dateRequired(effectiveDate, "탈락일"),
                text(reason, "사유", 2000), version);
    }

    public Person restore(AccessGrant grant, String id, String effectiveDate, String reason, Object rowVersion) {
        Person current = getPerson(grant, id);
        requireLive(current);
        long version = requireVersion(rowVersion);
        checkVersion(current, version);
        if (Person.ACTIVE.equals(current.status())) {
            throw ApiException.conflict("NOT_DROPPED", "탈락 상태가 아닙니다.");
        }
        return changeStatus(grant, current, Person.ACTIVE, HistoryEntry.RESTORED, dateRequired(effectiveDate, "복귀일"),
                text(reason, "사유", 2000), version);
    }

    private Person changeStatus(AccessGrant grant, Person current, String status, String type, String day, String why,
            long version) {
        AuditActor actor = AuditActor.of(grant);
        return unitOfWork.execute(() -> {
            Person saved = write(grant, current.id(), Map.of(PersonField.STATUS, status), PhoneUpdate.NONE, version);
            repository.appendHistory(statusEntry(saved, current.status(), status, day, why, actor), null, null);
            repository.appendHistory(changeEntry(saved, type, current.status(), status, day, why, actor), null, null);
            return saved;
        });
    }

    /** 삭제는 복구 가능한 소프트 삭제(DEL_IND)이며 원래 상태 코드는 그대로 둔다. */
    public void deletePerson(AccessGrant grant, String id, Object rowVersion) {
        Person current = getPerson(grant, id);
        requireLive(current);
        long version = requireVersion(rowVersion);
        checkVersion(current, version);
        AuditActor actor = AuditActor.of(grant);
        unitOfWork.run(() -> {
            Person saved = write(grant, id, Map.of(PersonField.DELETED, Boolean.TRUE), PhoneUpdate.NONE, version);
            repository.appendHistory(changeEntry(saved, HistoryEntry.DELETED, null, null, today(), null, actor), null, null);
        });
    }

    public Person undelete(AccessGrant grant, String id, Object rowVersion) {
        Person current = getPerson(grant, id);
        if (!current.deleted()) {
            throw ApiException.conflict("NOT_DELETED", "삭제된 대상자가 아닙니다.");
        }
        long version = requireVersion(rowVersion);
        checkVersion(current, version);
        AuditActor actor = AuditActor.of(grant);
        return unitOfWork.execute(() -> {
            Person saved = write(grant, id, Map.of(PersonField.DELETED, Boolean.FALSE), PhoneUpdate.NONE, version);
            repository.appendHistory(changeEntry(saved, HistoryEntry.UNDELETED, null, null, today(), null, actor), null, null);
            return saved;
        });
    }

    /**
     * 이 레코드의 연락처 봉투를 열 때 허용하는 AAD(레코드 기준 기대값). 이관 행(MIGMAP 에 원본 ID 가 있으면)의
     * `SMOA:v1:<LIB_ID>:TGMSTR:<SOURCE_ID>:PHONE_ENC` 와 웹에서 봉인한 행의 `...:TGMSTR:db:<TGT_ID>:PHONE_ENC`.
     * 봉투 안에 적힌 AAD 문자열은 신뢰하지 않는다(검증·점검용; 운영 API 가 원문을 돌려주는 데 쓰지 않는다).
     */
    public List<String> phoneAadCandidates(String personId) {
        List<String> aads = new java.util.ArrayList<>();
        repository.migrationSourceId(personId).ifPresent(source -> aads.add(ContactVault.migratedAad(libraryId(), source)));
        aads.add(ContactVault.newAad(libraryId(), personId));
        return aads;
    }

    // ================= 활동 =================

    public Page<Activity> pageActivities(AccessGrant grant, ActivityFilter filter) {
        return queryActivities(grant, filter, PAGE_DEFAULT, PAGE_MAX);
    }

    public Page<Activity> listActivities(AccessGrant grant, ActivityFilter filter) {
        return queryActivities(grant, filter, DEFAULT_LIMIT, MAX_LIMIT);
    }

    private Page<Activity> queryActivities(AccessGrant grant, ActivityFilter filter, int defaultLimit, int maxLimit) {
        int limit = limit(filter.limit(), defaultLimit, maxLimit);
        int offset = Math.max(0, filter.offset());
        DataScope scope = enforcer.effectiveScope(grant);
        ActivityQuery query = activityQuery(filter, limit, offset);
        if (scope.isEmptyAssignment()) {
            return new Page<>(List.of(), 0, limit, offset);
        }
        long total = repository.countActivities(query, scope);
        List<Activity> rows = total == 0 || offset >= total ? List.of() : repository.searchActivities(query, scope);
        return new Page<>(rows, total, limit, offset);
    }

    private ActivityQuery activityQuery(ActivityFilter filter, int limit, int offset) {
        return new ActivityQuery(blankToNull(filter.personId()), filter.standalone(), blankToNull(filter.regionCode()),
                blankToNull(filter.districtCode()), optionalDate(filter.from(), "시작일"), optionalDate(filter.to(), "종료일"),
                limit, offset);
    }

    public Activity getActivity(AccessGrant grant, String id) {
        return repository.findActivity(id, enforcer.effectiveScope(grant)).filter(a -> !a.deleted())
                .filter(a -> enforcer.visible(grant, a.districtKey())).orElseThrow(RecordsService::notFound);
    }

    public Activity createActivity(AccessGrant grant, Map<String, Object> body) {
        Map<String, Object> input = new LinkedHashMap<>(body);
        input.remove("rowVersion");
        Object personRaw = input.remove("personId");
        Map<ActivityField, Object> values = parseActivityFields(input, true);
        String personId = personRaw == null || personRaw.toString().isBlank() ? null : personRaw.toString();
        DistrictKey district;
        if (personId != null) {
            Person person = getPerson(grant, personId);
            requireLive(person);
            district = person.districtKey();
            if (input.containsKey("regionCode") || input.containsKey("districtCode")) {
                DistrictKey given = requireDistrict(input);
                if (!given.equals(district)) {
                    throw bad("대상자 활동의 구역은 대상자의 구역과 같아야 합니다.");
                }
            }
        } else {
            district = requireDistrict(input);
        }
        if (!enforcer.visible(grant, district)) {
            throw outOfScope();
        }
        if (district != null) {
            values.put(ActivityField.REGION_CODE, district.regionCode());
            values.put(ActivityField.DISTRICT_CODE, district.districtCode());
        }
        if (values.get(ActivityField.KIND) == null) {
            throw bad("활동 종류: 필수 항목입니다.");
        }
        deriveMinutes(values);
        values.put(ActivityField.DELETED, Boolean.FALSE);
        AuditActor actor = AuditActor.of(grant);
        return unitOfWork.execute(() -> {
            Activity saved = repository.insertActivity(new Activity(null, personId, null, values, 0, null, null));
            repository.appendHistory(activityEntry(saved, "activity.create", actor), null, afterActivityJson(values));
            return saved;
        });
    }

    public Activity updateActivity(AccessGrant grant, String id, Map<String, Object> body) {
        Activity current = getActivity(grant, id);
        Map<String, Object> input = new LinkedHashMap<>(body);
        long version = requireVersion(input.remove("rowVersion"));
        if (input.containsKey("personId") || input.containsKey("deleted")) {
            throw bad("대상자 연결과 삭제 여부는 이 요청으로 바꿀 수 없습니다.");
        }
        Map<ActivityField, Object> changes = parseActivityFields(input, false);
        boolean hasRegion = input.containsKey("regionCode");
        if (hasRegion != input.containsKey("districtCode")) {
            throw bad("지역·구역: 지역 코드와 구역 코드를 함께 보내 주세요.");
        }
        if (hasRegion) {
            if (!current.standalone()) {
                throw bad("대상자에 속한 활동의 구역은 바꿀 수 없습니다.");
            }
            DistrictKey district = requireDistrict(input);
            if (!enforcer.visible(grant, district)) {
                throw outOfScope();
            }
            changes.put(ActivityField.REGION_CODE, district.regionCode());
            changes.put(ActivityField.DISTRICT_CODE, district.districtCode());
        }
        Map<ActivityField, Object> effective = new EnumMap<>(ActivityField.class);
        changes.forEach((k, v) -> {
            if (!Objects.equals(current.values().get(k), v)) {
                effective.put(k, v);
            }
        });
        if (current.rowVersion() != version) {
            throw versionConflict();
        }
        if (effective.isEmpty()) {
            return current;
        }
        AuditActor actor = AuditActor.of(grant);
        return unitOfWork.execute(() -> {
            Activity saved = writeActivity(grant, id, effective, version);
            repository.appendHistory(activityEntry(saved, "activity.update", actor), null, afterActivityJson(effective));
            return saved;
        });
    }

    public void deleteActivity(AccessGrant grant, String id, Object rowVersion) {
        Activity current = getActivity(grant, id);
        long version = requireVersion(rowVersion);
        if (current.rowVersion() != version) {
            throw versionConflict();
        }
        AuditActor actor = AuditActor.of(grant);
        unitOfWork.run(() -> {
            Activity saved = writeActivity(grant, id, Map.of(ActivityField.DELETED, Boolean.TRUE), version);
            repository.appendHistory(activityEntry(saved, "activity.delete", actor), null, null);
        });
    }

    /**
     * 대상자 활동과 독립 활동(대상자 없음)을 나눠 센다. 목록 화면과 같은 조건(대상자·독립 여부·구역·기간)·같은 범위의
     * <b>전체</b>를 SQL 이 집계하며 페이지 크기와 무관하다.
     */
    public Map<String, Object> activitySummary(AccessGrant grant, ActivityFilter filter) {
        DataScope scope = enforcer.effectiveScope(grant);
        ActivityQuery query = activityQuery(filter, 1, 0);
        RecordRepository.ActivityTotals t = scope.isEmptyAssignment() ? new RecordRepository.ActivityTotals(0, 0, 0, 0)
                : repository.summarizeActivities(query, scope);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("total", t.total());
        result.put("personActivities", Map.of("count", t.personCount(), "minutes", t.personMinutes()));
        result.put("standaloneActivities", Map.of("count", t.standaloneCount(), "minutes", t.standaloneMinutes()));
        return result;
    }

    // ================= 이력·집계 =================

    /** 이력 한 쪽(최신순, 기본 50·최대 200). 단계·상태 로그와 중복되는 감사 항목은 SQL 에서 제외된다. */
    public Page<HistoryEntry> pageHistory(AccessGrant grant, HistoryFilter filter) {
        return queryHistory(grant, filter, PAGE_DEFAULT, PAGE_MAX);
    }

    public Page<HistoryEntry> listHistory(AccessGrant grant, HistoryFilter filter) {
        return queryHistory(grant, filter, DEFAULT_LIMIT, MAX_LIMIT);
    }

    private Page<HistoryEntry> queryHistory(AccessGrant grant, HistoryFilter filter, int defaultLimit, int maxLimit) {
        int limit = limit(filter.limit(), defaultLimit, maxLimit);
        int offset = Math.max(0, filter.offset());
        String from = optionalDate(filter.from(), "시작일");
        String to = optionalDate(filter.to(), "종료일");
        String kind = blankToNull(filter.kind());
        if (kind != null && !Set.of(HistoryEntry.KIND_STAGE, HistoryEntry.KIND_STATUS, HistoryEntry.KIND_CHANGE).contains(kind)) {
            throw bad("이력 종류: STAGE, STATUS, CHANGE 중 하나여야 합니다.");
        }
        DataScope scope = enforcer.effectiveScope(grant);
        if (scope.isEmptyAssignment()) {
            return new Page<>(List.of(), 0, limit, offset);
        }
        RecordRepository.HistoryPage page = repository.history(
                new RecordRepository.HistoryQuery(blankToNull(filter.personId()), from, to, kind, limit, offset), scope);
        return new Page<>(page.items(), page.total(), limit, offset);
    }

    /**
     * 단계 이동 분석: 범위 안 단계 이동(기준 행 제외)을 (이전→이후)별로 센다. 단계 로그(TGSTGLOG) 전체에서 SQL 이 집계하므로
     * 이력 목록의 페이지·건수 제한과 무관하고 변경 이력(CHGLOG)을 이중으로 세지 않는다.
     */
    public Map<String, Object> stageSummary(AccessGrant grant, String from, String to, String regionCode, String districtCode) {
        String f = optionalDate(from, "시작일");
        String t = optionalDate(to, "종료일");
        DataScope scope = enforcer.effectiveScope(grant);
        Map<String, Long> counts = scope.isEmptyAssignment() ? Map.of()
                : repository.stageTransitions(new RecordRepository.StageQuery(f, t, blankToNull(regionCode), blankToNull(districtCode)), scope);
        long total = counts.values().stream().mapToLong(Long::longValue).sum();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("total", total);
        result.put("transitions", counts);
        return result;
    }

    // ================= 내부: 쓰기 =================

    /** 대상자 한 행을 낙관적 잠금으로 바꾼다. 다른 사람이 먼저 바꿨으면 409, 범위 밖이면 404. */
    private Person write(AccessGrant grant, String id, Map<PersonField, Object> changes, PhoneUpdate phone, long version) {
        WriteResult<Person> result = repository.updatePerson(id, changes, phone, version, enforcer.effectiveScope(grant));
        return outcome(result);
    }

    private Activity writeActivity(AccessGrant grant, String id, Map<ActivityField, Object> changes, long version) {
        return outcome(repository.updateActivity(id, changes, version, enforcer.effectiveScope(grant)));
    }

    private static <T> T outcome(WriteResult<T> result) {
        if (result.outcome() == Outcome.NOT_FOUND) {
            throw notFound();
        }
        if (result.outcome() == Outcome.CONFLICT) {
            throw versionConflict();
        }
        return result.value();
    }

    // ================= 내부: 입력 =================

    private static final Set<String> PERSON_BODY_KEYS;
    private static final Set<String> ACTIVITY_BODY_KEYS;

    static {
        Set<String> person = new java.util.HashSet<>();
        for (PersonField f : PersonField.values()) {
            if (f.editable()) {
                person.add(f.key());
            }
        }
        person.addAll(List.of("registeredDate", "regionCode", "districtCode", "stageId"));
        PERSON_BODY_KEYS = Collections.unmodifiableSet(person);
        Set<String> activity = new java.util.HashSet<>();
        for (ActivityField f : ActivityField.values()) {
            if (f.editable()) {
                activity.add(f.key());
            }
        }
        activity.addAll(List.of("regionCode", "districtCode"));
        ACTIVITY_BODY_KEYS = Collections.unmodifiableSet(activity);
    }

    /**
     * 본문 → 정규화된 필드 맵. 맵에 키가 있으면(null 값 포함) 그 필드를 지정한 것이다(null = 지움).
     * 허용 목록 밖의 키는 400. 구역 쌍·단계는 호출자가 따로 처리한다.
     */
    private Map<PersonField, Object> parsePersonFields(Map<String, Object> input, boolean creating) {
        for (String key : input.keySet()) {
            if (!PERSON_BODY_KEYS.contains(key) || "stageId".equals(key) && !creating) {
                throw ApiException.badRequest("UNKNOWN_FIELD", "허용되지 않은 필드가 있습니다: " + safeKey(key));
            }
        }
        Map<String, Object> source = new LinkedHashMap<>(input);
        if (source.containsKey("registeredDate")) {
            Object alias = source.remove("registeredDate");
            if (source.containsKey("foundDate") && !Objects.equals(blankToNull(str(alias)), blankToNull(str(source.get("foundDate"))))) {
                throw bad("등록일(registeredDate)과 찾은 날짜(foundDate)가 서로 다릅니다.");
            }
            source.putIfAbsent("foundDate", alias);
        }
        Map<PersonField, Object> values = new EnumMap<>(PersonField.class);
        for (PersonField field : PersonField.values()) {
            if (!field.editable() || !source.containsKey(field.key())) {
                continue;
            }
            Object normalized = FieldValidator.normalize(field, source.get(field.key()));
            if (field == PersonField.CODE && normalized != null) {
                String code = normalized.toString();
                if (!CODE.matcher(code).matches() || FOUR_DIGITS.matcher(code).matches()) {
                    throw bad("식별번호: 영문·숫자·-·_ 3~60자로 입력하고, 네 자리 숫자만으로는 만들 수 없습니다.");
                }
            }
            values.put(field, normalized);
        }
        if (creating && values.get(PersonField.NAME) == null) {
            throw FieldValidator.bad(PersonField.NAME, "필수 항목입니다.");
        }
        return values;
    }

    private Map<ActivityField, Object> parseActivityFields(Map<String, Object> input, boolean creating) {
        for (String key : input.keySet()) {
            if (!ACTIVITY_BODY_KEYS.contains(key)) {
                throw ApiException.badRequest("UNKNOWN_FIELD", "허용되지 않은 필드가 있습니다: " + safeKey(key));
            }
        }
        Map<ActivityField, Object> values = new EnumMap<>(ActivityField.class);
        for (ActivityField field : ActivityField.values()) {
            if (!field.editable() || !input.containsKey(field.key())) {
                continue;
            }
            values.put(field, FieldValidator.normalize(field, input.get(field.key())));
        }
        if (creating && values.get(ActivityField.DATE) == null) {
            throw FieldValidator.bad(ActivityField.DATE, "필수 항목입니다.");
        }
        return values;
    }

    /** 분이 없고 시작·종료 시각이 모두 있으면 종료-시작(분)으로 채운다(종료가 더 늦을 때만). */
    private static void deriveMinutes(Map<ActivityField, Object> values) {
        if (values.get(ActivityField.MINUTES) != null) {
            return;
        }
        String start = (String) values.get(ActivityField.START_TIME);
        String end = (String) values.get(ActivityField.END_TIME);
        if (start != null && end != null) {
            int diff = toMinutes(end) - toMinutes(start);
            if (diff > 0) {
                values.put(ActivityField.MINUTES, diff);
            }
        }
    }

    private static int toMinutes(String hhmm) {
        return Integer.parseInt(hhmm.substring(0, 2)) * 60 + Integer.parseInt(hhmm.substring(3, 5));
    }

    private static DistrictKey requireDistrict(Map<String, Object> input) {
        String region = blankToNull(str(input.get("regionCode")));
        String district = blankToNull(str(input.get("districtCode")));
        if (!DistrictKey.valid(region, district)) {
            throw bad("지역·구역: 지역 코드와 구역 코드를 함께 선택해 주세요.");
        }
        return new DistrictKey(region, district);
    }

    private String requireActiveStage(Object raw) {
        String stage = blankToNull(str(raw));
        if (stage == null) {
            throw bad("단계: 선택 항목을 확인해 주세요.");
        }
        boolean ok = repository.codes().getOrDefault(STAGE_GROUP, List.of()).stream()
                .anyMatch(item -> item.active() && item.value().equals(stage));
        if (!ok) {
            throw bad("단계: 선택 항목을 확인해 주세요.");
        }
        return stage;
    }

    private void checkIntroducer(AccessGrant grant, Map<PersonField, Object> values) {
        Object id = values.get(PersonField.INTRODUCER_ID);
        if (id != null && !repository.employeeExists(id.toString(), enforcer.effectiveScope(grant))) {
            throw bad("조회할 수 있는 명부에서 인도자를 선택해 주세요.");
        }
    }

    private static long requireVersion(Object raw) {
        if (raw == null) {
            throw ApiException.badRequest("ROW_VERSION_REQUIRED", "변경에는 조회한 rowVersion 이 필요합니다.");
        }
        try {
            long v = raw instanceof Number n ? n.longValue() : Long.parseLong(raw.toString().strip());
            if (v < 1) {
                throw new NumberFormatException();
            }
            return v;
        } catch (NumberFormatException e) {
            throw ApiException.badRequest("ROW_VERSION_REQUIRED", "rowVersion 형식이 올바르지 않습니다.");
        }
    }

    /** 조회한 rowVersion 이 현재와 다르면 409(지연된 클라이언트가 최신 값을 덮어쓰지 못한다). 저장 SQL 도 같은 조건으로 한 번 더 막는다. */
    private static void checkVersion(Person current, long version) {
        if (current.rowVersion() != version) {
            throw versionConflict();
        }
    }

    private static String dateOrToday(String value, String label) {
        return blankToNull(value) == null ? today() : dateRequired(value, label);
    }

    private static String dateRequired(String value, String label) {
        LocalDate d = FieldValidator.parseDate(value == null ? null : value.strip());
        if (d == null) {
            throw bad(label + ": YYYY-MM-DD 형식의 올바른 날짜를 입력해 주세요.");
        }
        if (d.isAfter(LocalDate.now(FieldValidator.SEOUL))) {
            throw bad(label + ": 오늘 이후 날짜는 기록할 수 없습니다.");
        }
        return d.toString();
    }

    private static String optionalDate(String value, String label) {
        String v = blankToNull(value);
        if (v == null) {
            return null;
        }
        if (FieldValidator.parseDate(v) == null) {
            throw bad(label + ": YYYY-MM-DD 형식의 올바른 날짜를 입력해 주세요.");
        }
        return v;
    }

    private static String text(String value, String label, int max) {
        String s = value == null ? "" : value.strip();
        if (s.length() > max) {
            throw bad(label + ": " + max + "자 이하로 입력해 주세요.");
        }
        return s.isEmpty() ? null : s;
    }

    // ================= 내부: 이력 항목 =================

    private record AuditActor(String accountId, String name) {
        static AuditActor of(AccessGrant grant) {
            return new AuditActor(grant.accountId(), grant.account().displayName());
        }
    }

    private HistoryEntry stageEntry(Person p, String from, String to, String day, String time, boolean baseline,
            AuditActor actor, String reason) {
        String at = time == null ? day + "T00:00:00" : day + "T" + (time.length() == 5 ? time + ":00" : time);
        return new HistoryEntry(null, HistoryEntry.KIND_STAGE, p.id(), p.districtKey(),
                baseline ? HistoryEntry.STAGE_BASELINE : HistoryEntry.STAGE_CHANGED, from, to, day, at, time == null,
                baseline, reason, actor.accountId(), actor.name(), nowUtc(), null, null, null);
    }

    private HistoryEntry statusEntry(Person p, String from, String to, String day, String reason, AuditActor actor) {
        return new HistoryEntry(null, HistoryEntry.KIND_STATUS, p.id(), p.districtKey(),
                Person.DROPPED.equals(to) ? HistoryEntry.DROPPED : HistoryEntry.RESTORED, from, to, day,
                day + "T00:00:00", true, false, reason, actor.accountId(), actor.name(), nowUtc(), null, null, null);
    }

    private HistoryEntry changeEntry(Person p, String type, String from, String to, String day, String reason,
            AuditActor actor) {
        return new HistoryEntry(null, HistoryEntry.KIND_CHANGE, p.id(), p.districtKey(), type, from, to, day, null,
                false, false, reason, actor.accountId(), actor.name(), nowUtc(), ChangeActions.actionOf(type), "TGMSTR",
                p.id());
    }

    private HistoryEntry activityEntry(Activity a, String action, AuditActor actor) {
        return new HistoryEntry(null, HistoryEntry.KIND_CHANGE, a.personId(), a.districtKey(),
                HistoryEntry.ACTIVITY_CHANGED, null, null, a.date(), null, false, false, null, actor.accountId(),
                actor.name(), nowUtc(), action, "ACTMSTR", a.id());
    }

    private static String beforeJson(Person current, Set<PersonField> keys) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (PersonField k : keys) {
            m.put(k.key(), current.values().get(k));
        }
        return json(m);
    }

    private static String afterJson(Map<PersonField, Object> values) {
        Map<String, Object> m = new LinkedHashMap<>();
        values.forEach((k, v) -> {
            if (k != PersonField.DELETED) {
                m.put(k.key(), v);
            }
        });
        return json(m);
    }

    private static String afterActivityJson(Map<ActivityField, Object> values) {
        Map<String, Object> m = new LinkedHashMap<>();
        values.forEach((k, v) -> m.put(k.key(), v));
        return json(m);
    }

    /** 변경 이력 JSON: 문자열 값 안의 연락처 형태 숫자열은 가린다(연락처 원문은 이력에 남기지 않는다). */
    static String json(Map<String, Object> map) {
        Map<String, Object> masked = new LinkedHashMap<>();
        map.forEach((k, v) -> masked.put(k, v instanceof String s ? PHONE_IN_TEXT.matcher(s).replaceAll("[연락처 비공개]") : v));
        try {
            return JSON.writeValueAsString(masked);
        } catch (JsonProcessingException e) {
            return "{}";
        }
    }

    // ================= 내부: 공통 =================

    private String libraryId() {
        LibraryContext context = library.getIfAvailable();
        return context == null ? "memory" : context.id();
    }

    private static int limit(int requested, int defaultLimit, int maxLimit) {
        return requested <= 0 ? defaultLimit : Math.min(requested, maxLimit);
    }

    private static void requireLive(Person person) {
        if (person.deleted()) {
            throw notFound();
        }
    }

    private static String today() {
        return LocalDate.now(FieldValidator.SEOUL).toString();
    }

    private static String nowUtc() {
        return Instant.now().truncatedTo(ChronoUnit.SECONDS).toString();
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    private static String str(Object o) {
        return o == null ? null : o.toString();
    }

    private static String safeKey(String key) {
        return key.length() > 40 ? key.substring(0, 40) : key.replaceAll("[^\\p{L}\\p{N}_.-]", "?");
    }

    private static ApiException notFound() {
        return ApiException.notFound("자료를 찾을 수 없습니다.");
    }

    private static ApiException outOfScope() {
        return ApiException.forbidden("OUT_OF_SCOPE", "접근할 수 없는 구역입니다.");
    }

    private static ApiException versionConflict() {
        return ApiException.conflict("VERSION_CONFLICT", "다른 사용자가 먼저 수정했습니다. 새로 조회한 뒤 다시 시도해 주세요.");
    }

    private static ApiException bad(String message) {
        return ApiException.badRequest("INVALID_INPUT", message);
    }

}
