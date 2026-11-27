package com.smoa.records.persistence;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeSet;
import java.util.regex.Pattern;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;

import com.smoa.audit.AuditStamp;
import com.smoa.config.LibraryContext;
import com.smoa.crypto.ContactVault.PhoneSecret;
import com.smoa.module.mapper.RecordsMapper;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.permission.ScopeType;
import com.smoa.records.Activity;
import com.smoa.records.ActivityField;
import com.smoa.records.ChangeActions;
import com.smoa.records.FieldValidator;
import com.smoa.records.HistoryEntry;
import com.smoa.records.Person;
import com.smoa.records.PersonField;
import com.smoa.records.RecordField;
import com.smoa.records.RecordRepository;

/**
 * local/prod 어댑터: RecordsMapper(XML)로 TGMSTR/ACTMSTR/TGSTGLOG/TGSTATLOG/CHGLOG 를 읽고 쓴다.
 * 이 클래스는 SQL 이 없고 (1) 행 Map ↔ 도메인 변환, (2) 구역 범위 → SQL 파라미터 변환, (3) 감사 값(SYS_*)·해시 체인 값 채우기만 한다.
 * 모든 호출에 서버 설정의 LIB_ID 를 넘긴다. 쓰기는 서비스의 트랜잭션 안에서 호출된다.
 */
@Repository
@Profile({"local", "prod"})
public class MyBatisRecordRepository implements RecordRepository {

    private static final Pattern NUMERIC_ID = Pattern.compile("\\d{1,19}");
    private static final int MAX_LIMIT = 50000;

    private final RecordsMapper mapper;
    private final LibraryContext library;

    public MyBatisRecordRepository(RecordsMapper mapper, LibraryContext library) {
        this.mapper = mapper;
        this.library = library;
    }

    // ---- 공통코드/참조 ----

    @Override
    public Map<String, List<CodeItem>> codes() {
        Map<String, List<CodeItem>> result = new LinkedHashMap<>();
        for (Map<String, Object> row : mapper.selectCodeItems(library.id())) {
            result.computeIfAbsent(String.valueOf(row.get("groupCode")), k -> new ArrayList<>())
                    .add(new CodeItem(String.valueOf(row.get("itemCode")), str(row.get("itemName")),
                            number(row.get("sortOrder")).intValue(), bool(row.get("active"))));
        }
        return result;
    }

    @Override
    public boolean employeeExists(String employeeId, DataScope scope) {
        return mapper.countEmployee(employeeId, scopeAll(scope), districts(scope), unassigned(scope)) > 0;
    }

    @Override
    public EmployeePage searchEmployees(String q, DataScope scope, int limit) {
        if (scope.isEmptyAssignment()) {
            return new EmployeePage(List.of(), 0);
        }
        String needle = blankToNull(q);
        List<EmployeeOption> items = new ArrayList<>();
        for (Map<String, Object> r : mapper.selectEmployees(needle, Math.min(100, Math.max(1, limit)), scopeAll(scope),
                districts(scope), unassigned(scope))) {
            String region = str(r.get("regionCode"));
            String district = str(r.get("districtCode"));
            items.add(new EmployeeOption(str(r.get("id")), str(r.get("code")), str(r.get("name")),
                    DistrictKey.valid(region, district) ? new DistrictKey(region, district) : null));
        }
        return new EmployeePage(items, mapper.countEmployees(needle, scopeAll(scope), districts(scope), unassigned(scope)));
    }

    // ---- 대상자 ----

    @Override
    public List<Person> searchPeople(PeopleQuery q, DataScope scope) {
        if (scope.isEmptyAssignment()) {
            return List.of();
        }
        Map<String, Object> f = peopleFilter(q);
        f.put("limit", clamp(q.limit()));
        f.put("offset", Math.max(0, q.offset()));
        return mapper.selectPeople(library.id(), f, scopeAll(scope), districts(scope), unassigned(scope)).stream()
                .map(MyBatisRecordRepository::toPerson).toList();
    }

    @Override
    public long countPeople(PeopleQuery q, DataScope scope) {
        if (scope.isEmptyAssignment()) {
            return 0;
        }
        return mapper.countPeople(library.id(), peopleFilter(q), scopeAll(scope), districts(scope), unassigned(scope));
    }

    private static Map<String, Object> peopleFilter(PeopleQuery q) {
        Map<String, Object> f = new HashMap<>();
        f.put("includeDeleted", q.includeDeleted());
        f.put("regionCode", blankToNull(q.regionCode()));
        f.put("districtCode", blankToNull(q.districtCode()));
        f.put("stageId", blankToNull(q.stageId()));
        f.put("status", blankToNull(q.status()));
        f.put("phoneLast4", blankToNull(q.phoneLast4()));
        f.put("foundFrom", date(q.foundFrom()));
        f.put("foundTo", date(q.foundTo()));
        f.put("q", blankToNull(q.q()));
        return f;
    }

    @Override
    public Optional<Person> findPerson(String id, DataScope scope) {
        if (id == null || !NUMERIC_ID.matcher(id).matches() || scope.isEmptyAssignment()) {
            return Optional.empty();
        }
        return Optional.ofNullable(mapper.selectPersonById(library.id(), id, scopeAll(scope), districts(scope), unassigned(scope)))
                .map(MyBatisRecordRepository::toPerson);
    }

    @Override
    public Person insertPerson(Person person) {
        Map<String, Object> row = new HashMap<>();
        row.put("libId", library.id());
        for (PersonField field : PersonField.values()) {
            row.put(field.key(), toDb(field, person.values().get(field)));
        }
        stamp(row);
        mapper.insertPerson(row);
        Object id = row.get("id");
        if (id == null) {
            throw new IllegalStateException("대상자 생성 후 TGT_ID 를 받지 못했습니다.");
        }
        return findPerson(id.toString(), DataScope.all())
                .orElseThrow(() -> new IllegalStateException("생성한 대상자를 다시 읽지 못했습니다."));
    }

    @Override
    public WriteResult<Person> updatePerson(String id, Map<PersonField, Object> changes, PhoneUpdate phone,
            long expectedVersion, DataScope scope) {
        if (id == null || !NUMERIC_ID.matcher(id).matches() || scope.isEmptyAssignment()) {
            return WriteResult.of(Outcome.NOT_FOUND);
        }
        Map<String, Object> row = new HashMap<>();
        row.put("libId", library.id());
        row.put("id", id);
        row.put("expectedVersion", expectedVersion);
        TreeSet<String> changed = new TreeSet<>();
        for (Map.Entry<PersonField, Object> e : changes.entrySet()) {
            changed.add(e.getKey().key());
            row.put(e.getKey().key(), toDb(e.getKey(), e.getValue()));
        }
        row.put("changed", changed);
        row.put("phoneChange", phone.change());
        row.put("phoneEnc", phone.secret() == null ? null : phone.secret().envelope());
        row.put("phoneLast4", phone.secret() == null ? null : phone.secret().last4());
        row.put("phoneKeyVer", phone.secret() == null ? null : phone.secret().keyVersion());
        row.put("scopeAll", scopeAll(scope));
        row.put("districts", districts(scope));
        row.put("unassigned", unassigned(scope));
        stamp(row);
        int updated = mapper.updatePerson(row);
        if (updated == 1) {
            return WriteResult.ok(findPerson(id, DataScope.all())
                    .orElseThrow(() -> new IllegalStateException("수정한 대상자를 다시 읽지 못했습니다.")));
        }
        return WriteResult.of(findPerson(id, scope).isPresent() ? Outcome.CONFLICT : Outcome.NOT_FOUND);
    }

    @Override
    public void attachInitialPhone(String id, PhoneSecret secret) {
        Map<String, Object> row = new HashMap<>();
        row.put("libId", library.id());
        row.put("id", id);
        row.put("phoneEnc", secret.envelope());
        row.put("phoneLast4", secret.last4());
        row.put("phoneKeyVer", secret.keyVersion());
        if (mapper.attachInitialPhone(row) != 1) {
            throw new IllegalStateException("새 대상자에 연락처를 붙이지 못했습니다.");
        }
    }

    @Override
    public Optional<String> migrationSourceId(String personId) {
        return Optional.ofNullable(mapper.selectMigrationSourceId(library.id(), personId));
    }

    // ---- 활동 ----

    @Override
    public List<Activity> searchActivities(ActivityQuery q, DataScope scope) {
        if (scope.isEmptyAssignment()) {
            return List.of();
        }
        Map<String, Object> f = activityFilter(q);
        if (f == null) {
            return List.of();
        }
        f.put("limit", clamp(q.limit()));
        f.put("offset", Math.max(0, q.offset()));
        return mapper.selectActivities(library.id(), f, scopeAll(scope), districts(scope), unassigned(scope)).stream()
                .map(MyBatisRecordRepository::toActivity).toList();
    }

    @Override
    public long countActivities(ActivityQuery q, DataScope scope) {
        Map<String, Object> f = scope.isEmptyAssignment() ? null : activityFilter(q);
        return f == null ? 0 : mapper.countActivities(library.id(), f, scopeAll(scope), districts(scope), unassigned(scope));
    }

    @Override
    public ActivityTotals summarizeActivities(ActivityQuery q, DataScope scope) {
        Map<String, Object> f = scope.isEmptyAssignment() ? null : activityFilter(q);
        if (f == null) {
            return new ActivityTotals(0, 0, 0, 0);
        }
        Map<String, Object> r = mapper.summarizeActivities(library.id(), f, scopeAll(scope), districts(scope), unassigned(scope));
        if (r == null) {
            return new ActivityTotals(0, 0, 0, 0);
        }
        return new ActivityTotals(number(r.get("personCount")).longValue(), number(r.get("personMinutes")).longValue(),
                number(r.get("standaloneCount")).longValue(), number(r.get("standaloneMinutes")).longValue());
    }

    /** 조건 Map. personId 가 숫자가 아니면 어떤 행에도 맞지 않으므로 null(빈 결과). */
    private static Map<String, Object> activityFilter(ActivityQuery q) {
        Map<String, Object> f = new HashMap<>();
        f.put("personId", numericOrNull(q.personId()));
        f.put("standalone", q.standalone());
        f.put("regionCode", blankToNull(q.regionCode()));
        f.put("districtCode", blankToNull(q.districtCode()));
        f.put("from", date(q.from()));
        f.put("to", date(q.to()));
        if (!blank(q.personId()) && f.get("personId") == null) {
            return null;
        }
        return f;
    }

    @Override
    public Optional<Activity> findActivity(String id, DataScope scope) {
        if (id == null || !NUMERIC_ID.matcher(id).matches() || scope.isEmptyAssignment()) {
            return Optional.empty();
        }
        return Optional.ofNullable(mapper.selectActivityById(library.id(), id, scopeAll(scope), districts(scope), unassigned(scope)))
                .map(MyBatisRecordRepository::toActivity);
    }

    @Override
    public Activity insertActivity(Activity activity) {
        Map<String, Object> row = new HashMap<>();
        row.put("libId", library.id());
        row.put("personId", activity.personId());
        for (ActivityField field : ActivityField.values()) {
            row.put(field.key(), toDb(field, activity.values().get(field)));
        }
        if (row.get("minutes") == null) {
            row.put("minutes", 0);   // ACT_MINUTES 는 NOT NULL
        }
        stamp(row);
        mapper.insertActivity(row);
        Object id = row.get("id");
        if (id == null) {
            throw new IllegalStateException("활동 생성 후 ACT_ID 를 받지 못했습니다.");
        }
        return findActivity(id.toString(), DataScope.all())
                .orElseThrow(() -> new IllegalStateException("생성한 활동을 다시 읽지 못했습니다."));
    }

    @Override
    public WriteResult<Activity> updateActivity(String id, Map<ActivityField, Object> changes, long expectedVersion,
            DataScope scope) {
        if (id == null || !NUMERIC_ID.matcher(id).matches() || scope.isEmptyAssignment()) {
            return WriteResult.of(Outcome.NOT_FOUND);
        }
        Map<String, Object> row = new HashMap<>();
        row.put("libId", library.id());
        row.put("id", id);
        row.put("expectedVersion", expectedVersion);
        TreeSet<String> changed = new TreeSet<>();
        for (Map.Entry<ActivityField, Object> e : changes.entrySet()) {
            changed.add(e.getKey().key());
            Object value = toDb(e.getKey(), e.getValue());
            if (e.getKey() == ActivityField.MINUTES && value == null) {
                value = 0;
            }
            row.put(e.getKey().key(), value);
        }
        row.put("changed", changed);
        row.put("scopeAll", scopeAll(scope));
        row.put("districts", districts(scope));
        row.put("unassigned", unassigned(scope));
        stamp(row);
        int updated = mapper.updateActivity(row);
        if (updated == 1) {
            return WriteResult.ok(findActivity(id, DataScope.all())
                    .orElseThrow(() -> new IllegalStateException("수정한 활동을 다시 읽지 못했습니다.")));
        }
        return WriteResult.of(findActivity(id, scope).isPresent() ? Outcome.CONFLICT : Outcome.NOT_FOUND);
    }

    // ---- 이력 ----

    @Override
    public void appendHistory(HistoryEntry entry, String beforeJson, String afterJson) {
        AuditStamp stamp = AuditStamp.current();
        switch (entry.kind()) {
            case HistoryEntry.KIND_STAGE -> {
                Map<String, Object> row = lifecycleRow(entry, stamp);
                row.put("seq", mapper.selectNextStageSeq(entry.personId()));
                row.put("timeUnknown", entry.timeUnknown());
                row.put("baseline", entry.baseline());
                mapper.insertStageLog(row);
            }
            case HistoryEntry.KIND_STATUS -> {
                Map<String, Object> row = lifecycleRow(entry, stamp);
                row.put("seq", mapper.selectNextStatusSeq(entry.personId()));
                mapper.insertStatusLog(row);
            }
            case HistoryEntry.KIND_CHANGE -> appendChange(entry, beforeJson, afterJson, stamp);
            default -> throw new IllegalArgumentException("알 수 없는 이력 종류");
        }
    }

    private Map<String, Object> lifecycleRow(HistoryEntry entry, AuditStamp stamp) {
        Map<String, Object> row = new HashMap<>();
        row.put("libId", library.id());
        row.put("personId", entry.personId());
        row.put("fromValue", entry.fromValue());
        row.put("toValue", entry.toValue());
        // 적용일시는 한국 업무 시각(분 단위는 :00 초). 기록일시는 UTC.
        row.put("effectiveAt", FieldValidator.businessDateTime(
                entry.effectiveAt() != null ? entry.effectiveAt() : entry.effectiveDate()));
        row.put("recordedAt", stamp.utcNow());
        row.put("actorId", entry.actorAccountId());
        row.put("actorName", entry.actorName());
        row.put("reason", entry.reason());
        row.put("sysUserId", stamp.userId());
        row.put("sysIp", stamp.ip());
        row.put("sysAt", stamp.utcNow());
        return row;
    }

    /** CHGLOG 해시 체인: 자료실 행을 잠가 직렬화하고 마지막 항목의 해시를 PREV_HASH 로 잇는다. */
    private void appendChange(HistoryEntry entry, String beforeJson, String afterJson, AuditStamp stamp) {
        mapper.lockLibrary(library.id());
        Map<String, Object> last = mapper.selectLastChangeLog(library.id());
        long seq = last == null ? 1L : number(last.get("seq")).longValue() + 1;
        String prevHash = last == null ? null : blankToNull(str(last.get("hash")));
        String action = entry.action() != null ? entry.action() : ChangeActions.actionOf(entry.type());
        Map<String, Object> row = new HashMap<>();
        row.put("libId", library.id());
        row.put("seq", seq);
        row.put("action", action);
        row.put("targetKind", entry.targetKind());
        row.put("targetId", entry.targetId());
        row.put("actorId", entry.actorAccountId());
        row.put("actorName", entry.actorName());
        row.put("beforeJson", beforeJson);
        row.put("afterJson", afterJson);
        row.put("prevHash", prevHash);
        row.put("entryHash", chainHash(prevHash, seq, action, entry.targetKind(), entry.targetId(),
                entry.actorAccountId(), stamp.utcNow(), beforeJson, afterJson));
        row.put("sysUserId", stamp.userId());
        row.put("sysIp", stamp.ip());
        row.put("sysAt", stamp.utcNow());
        mapper.insertChangeLog(row);
    }

    /** 이번 단계에서 새로 만드는 항목의 해시: SHA-256(이전 해시|순번|동작|대상 종류|대상 ID|처리자|UTC 시각|전|후). */
    static String chainHash(String prev, long seq, String action, String kind, String target, String actor,
            LocalDateTime at, String before, String after) {
        String joined = String.join("|", nz(prev), Long.toString(seq), nz(action), nz(kind), nz(target), nz(actor),
                at.toString(), nz(before), nz(after));
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(joined.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public HistoryPage history(HistoryQuery q, DataScope scope) {
        if (scope.isEmptyAssignment()) {
            return new HistoryPage(List.of(), 0);
        }
        String pid = numericOrNull(q.personId());
        if (!blank(q.personId()) && pid == null) {
            return new HistoryPage(List.of(), 0);
        }
        Map<String, Object> f = new HashMap<>();
        f.put("personId", pid);
        f.put("from", date(q.from()));
        f.put("to", date(q.to()));
        f.put("kind", blankToNull(q.kind()));
        long total = mapper.countHistory(library.id(), f, scopeAll(scope), districts(scope), unassigned(scope));
        f.put("limit", clamp(q.limit()));
        f.put("offset", Math.max(0, q.offset()));
        List<HistoryEntry> items = new ArrayList<>();
        for (Map<String, Object> r : mapper.selectHistory(library.id(), f, scopeAll(scope), districts(scope), unassigned(scope))) {
            String kind = str(r.get("kind"));
            switch (kind) {
                case HistoryEntry.KIND_STAGE -> {
                    boolean baseline = bool(r.get("baseline"));
                    items.add(entry("S-", kind, r, baseline ? HistoryEntry.STAGE_BASELINE : HistoryEntry.STAGE_CHANGED,
                            baseline, bool(r.get("timeUnknown")), null, null, null));
                }
                case HistoryEntry.KIND_STATUS -> {
                    String to = str(r.get("toValue"));
                    String type = Person.DROPPED.equals(to) ? HistoryEntry.DROPPED
                            : Person.ACTIVE.equals(to) ? HistoryEntry.RESTORED : HistoryEntry.STATUS_CHANGED;
                    items.add(entry("T-", kind, r, type, false, false, null, null, null));
                }
                default -> {
                    String action = str(r.get("action"));
                    items.add(entry("C-", HistoryEntry.KIND_CHANGE, r, ChangeActions.typeOf(action), false, false, action,
                            str(r.get("targetKind")), str(r.get("targetId"))));
                }
            }
        }
        return new HistoryPage(items, total);
    }

    @Override
    public Map<String, Long> stageTransitions(StageQuery q, DataScope scope) {
        Map<String, Long> counts = new LinkedHashMap<>();
        if (scope.isEmptyAssignment()) {
            return counts;
        }
        Map<String, Object> f = new HashMap<>();
        f.put("from", date(q.from()));
        f.put("to", date(q.to()));
        f.put("regionCode", blankToNull(q.regionCode()));
        f.put("districtCode", blankToNull(q.districtCode()));
        for (Map<String, Object> r : mapper.selectStageTransitions(library.id(), f, scopeAll(scope), districts(scope), unassigned(scope))) {
            counts.put(str(r.get("fromValue")) + " → " + str(r.get("toValue")), number(r.get("cnt")).longValue());
        }
        return counts;
    }

    private static HistoryEntry entry(String prefix, String kind, Map<String, Object> r, String type, boolean baseline,
            boolean timeUnknown, String action, String targetKind, String targetId) {
        String effectiveAt = str(r.get("effectiveAt"));
        String region = str(r.get("regionCode"));
        String district = str(r.get("districtCode"));
        DistrictKey key = DistrictKey.valid(region, district) ? new DistrictKey(region, district) : null;
        Object person = r.get("personId");
        return new HistoryEntry(prefix + r.get("id"), kind, person == null ? null : person.toString(), key, type,
                str(r.get("fromValue")), str(r.get("toValue")),
                effectiveAt == null ? null : effectiveAt.substring(0, Math.min(10, effectiveAt.length())), effectiveAt,
                timeUnknown, baseline, str(r.get("reason")), str(r.get("actorId")), str(r.get("actorName")),
                str(r.get("recordedAt")), action, targetKind, targetId);
    }

    // ---- 변환 ----

    static Person toPerson(Map<String, Object> row) {
        Map<PersonField, Object> values = new java.util.EnumMap<>(PersonField.class);
        for (PersonField field : PersonField.values()) {
            Object v = fromDb(field, row.get(field.key()));
            if (v != null) {
                values.put(field, v);
            }
        }
        values.put(PersonField.DELETED, bool(row.get("deleted")));
        return new Person(row.get("id").toString(), str(row.get("legacyId")), values, str(row.get("phoneLast4")),
                bool(row.get("hasPhone")), number(row.get("rowVersion")).longValue(), str(row.get("createdAt")),
                str(row.get("updatedAt")));
    }

    static Activity toActivity(Map<String, Object> row) {
        Map<ActivityField, Object> values = new java.util.EnumMap<>(ActivityField.class);
        for (ActivityField field : ActivityField.values()) {
            Object v = fromDb(field, row.get(field.key()));
            if (v != null) {
                values.put(field, v);
            }
        }
        values.put(ActivityField.DELETED, bool(row.get("deleted")));
        Object person = row.get("personId");
        return new Activity(row.get("id").toString(), person == null ? null : person.toString(), str(row.get("legacyId")),
                values, number(row.get("rowVersion")).longValue(), str(row.get("createdAt")), str(row.get("updatedAt")));
    }

    private static Object fromDb(RecordField field, Object raw) {
        if (raw == null) {
            return null;
        }
        return switch (field.type()) {
            case INT -> number(raw).intValue();
            case BOOL -> bool(raw);
            case TIME -> FieldValidator.canonicalTime(raw.toString());
            case DATE -> raw.toString().length() >= 10 ? raw.toString().substring(0, 10) : null;
            default -> raw.toString();
        };
    }

    /** 정규화된 도메인 값 → JDBC 바인딩 값(날짜·시각은 java.time, 불리언은 Boolean). */
    private static Object toDb(RecordField field, Object value) {
        if (value == null) {
            return field.type() == RecordField.Type.BOOL ? Boolean.FALSE : null;
        }
        return switch (field.type()) {
            case DATE -> LocalDate.parse(value.toString());
            case TIME -> {
                String t = value.toString();
                yield LocalTime.parse(t.length() == 5 ? t + ":00" : t);
            }
            case INT -> ((Number) value).intValue();
            case BOOL -> (Boolean) value;
            default -> value.toString();
        };
    }

    private static void stamp(Map<String, Object> row) {
        AuditStamp stamp = AuditStamp.current();
        row.put("sysUserId", stamp.userId());
        row.put("sysIp", stamp.ip());
        row.put("sysAt", stamp.utcNow());
    }

    // ---- 범위/유틸 ----

    /** SQL 에서 구역 조건이 없는 범위(ALL 이고 목록 제한 없음). */
    static boolean scopeAll(DataScope scope) {
        return scope.unrestricted();
    }

    /** ALL 이되 활성 구역만 보는 범위에서 구역 미지정 행도 보이게 한다. */
    static boolean unassigned(DataScope scope) {
        return scope.type() == ScopeType.ALL && scope.listedOnly();
    }

    /** ORG 범위의 (지역,구역) 쌍 목록. ALL 이면 비어 있다(scopeAll=true 가 우선). 정렬해 SQL 이 결정적이다. */
    static List<Map<String, String>> districts(DataScope scope) {
        if (scope.unrestricted()) {
            return List.of();
        }
        List<Map<String, String>> list = new ArrayList<>();
        for (DistrictKey key : new TreeSet<>(scope.districts())) {
            Map<String, String> pair = new HashMap<>();
            pair.put("regionCode", key.regionCode());
            pair.put("districtCode", key.districtCode());
            list.add(pair);
        }
        return list;
    }

    private static String date(String s) {
        return blank(s) ? null : (FieldValidator.parseDate(s.strip()) == null ? null : s.strip());
    }

    private static String numericOrNull(String id) {
        return id != null && NUMERIC_ID.matcher(id).matches() ? id : null;
    }

    private static int clamp(int limit) {
        return Math.min(MAX_LIMIT, Math.max(1, limit));
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    private static String blankToNull(String s) {
        return blank(s) ? null : s.strip();
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static String str(Object o) {
        return o == null ? null : o.toString();
    }

    private static Number number(Object o) {
        if (o instanceof Number n) {
            return n;
        }
        return o == null ? 0 : Long.valueOf(o.toString());
    }

    private static boolean bool(Object o) {
        if (o instanceof Boolean b) {
            return b;
        }
        if (o instanceof Number n) {
            return n.longValue() != 0;
        }
        return o != null && ("1".equals(o.toString()) || "true".equalsIgnoreCase(o.toString())
                || "Y".equalsIgnoreCase(o.toString()));
    }
}
