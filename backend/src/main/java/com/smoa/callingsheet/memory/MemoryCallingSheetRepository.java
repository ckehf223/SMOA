package com.smoa.callingsheet.memory;

import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.Function;
import java.util.function.LongFunction;
import java.util.function.Supplier;
import java.util.stream.Collectors;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;

import com.smoa.audit.AuditStamp;
import com.smoa.callingsheet.CallingSheetRepository;
import com.smoa.callingsheet.RoundEntry;
import com.smoa.callingsheet.ScopeSpec;
import com.smoa.callingsheet.SheetField;
import com.smoa.callingsheet.SheetMatcher;
import com.smoa.callingsheet.SheetQuery;
import com.smoa.callingsheet.SheetRow;
import com.smoa.crypto.ContactVault.PhoneSecret;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.records.Person;
import com.smoa.records.PersonField;
import com.smoa.records.RecordRepository;

/**
 * local-memory 전용 가상 저장소. 프로세스 안에서만 살며 DB 에 연결하지 않는다. 필터·범위·정렬은 {@link SheetMatcher}/{@link ScopeSpec}
 * 로 DB 구현(Mapper XML)과 같은 의미를 낸다. 모든 변경 메서드는 먼저 전부 검사한 뒤 한 번에 교체하므로 한 호출 안에서 부분 반영이 없다.
 * 대상자와 명부 선택지는 RecordRepository 의 가상 자료를 쓴다.
 */
@Repository
@Profile("local-memory")
public class MemoryCallingSheetRepository implements CallingSheetRepository {

    public static final String LIBRARY_ID = "LOCAL-MEMORY";
    private static final DateTimeFormatter UTC = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'");

    private final RecordRepository records;
    private final Map<Long, SheetRow> rows = new TreeMap<>();
    private final Map<Long, PhoneSecret> phones = new TreeMap<>();
    private final List<AuditEntry> audit = new ArrayList<>();
    private long nextId = 1;

    public MemoryCallingSheetRepository(RecordRepository records) {
        this.records = records;
    }

    @Override
    public String libraryId() {
        return LIBRARY_ID;
    }

    /** 테스트용 초기화. */
    public synchronized void clear() {
        rows.clear();
        phones.clear();
        audit.clear();
        nextId = 1;
    }

    /** 테스트용: 남긴 감사 줄(정제된 JSON 만 있다). */
    public synchronized List<AuditEntry> auditEntries() {
        return List.copyOf(audit);
    }

    /** 테스트용: 서버 내부 봉인본(sourceEnc)·행 상태를 그대로 본다. */
    public synchronized Optional<SheetRow> raw(long id) {
        return Optional.ofNullable(rows.get(id));
    }

    /** 테스트용: 메모리 저장소에도 평문 대신 봉인된 연락처만 남는지 확인한다. */
    public synchronized Optional<PhoneSecret> phoneForTest(long id) {
        return Optional.ofNullable(phones.get(id));
    }

    @Override
    public synchronized Page search(SheetQuery q, ScopeSpec scope) {
        List<SheetRow> all = filtered(q, scope).sorted(SheetMatcher.comparator(q.sort(), q.desc())).toList();
        int from = Math.min(Math.max(0, q.offset()), all.size());
        int to = Math.min(all.size(), from + Math.max(0, q.size()));
        return new Page(all.subList(from, to), all.size());
    }

    @Override
    public synchronized List<SheetRow> findAll(SheetQuery q, ScopeSpec scope, int max) {
        return filtered(q, scope).sorted(SheetMatcher.comparator(q.sort(), q.desc())).limit(max).toList();
    }

    private java.util.stream.Stream<SheetRow> filtered(SheetQuery q, ScopeSpec scope) {
        if (scope.isEmpty()) {
            return java.util.stream.Stream.empty();
        }
        return rows.values().stream().filter(r -> SheetMatcher.matches(r, q, scope));
    }

    @Override
    public synchronized Stats stats(SheetQuery q, ScopeSpec scope) {
        List<SheetRow> list = filtered(q, scope).toList();
        long unassigned = list.stream().filter(r -> r.assignedUserId() == null && r.assignedUserName().isEmpty()).count();
        long manpik = list.stream().filter(r -> r.manpikConfirmedAt() != null).count();
        return new Stats(list.size(), unassigned, manpik, counts(list, SheetRow::callStatus), districts(list),
                counts(list, SheetRow::callResult));
    }

    private static List<Count> counts(List<SheetRow> list, Function<SheetRow, String> key) {
        return list.stream().collect(Collectors.groupingBy(key, Collectors.counting())).entrySet().stream()
                .map(e -> new Count(e.getKey(), e.getValue()))
                .sorted(Comparator.comparingLong(Count::count).reversed().thenComparing(Count::key)).toList();
    }

    private static List<DistrictCount> districts(List<SheetRow> list) {
        Map<String, Long> grouped = new LinkedHashMap<>();
        for (SheetRow r : list) {
            String k = r.regionCode() == null || r.districtCode() == null ? "\u0000" : r.regionCode() + "\u0000" + r.districtCode();
            grouped.merge(k, 1L, Long::sum);
        }
        return grouped.entrySet().stream().map(e -> {
            String[] p = e.getKey().split("\u0000", -1);
            boolean none = p.length < 2 || p[0].isEmpty();
            return new DistrictCount(none ? null : p[0], none ? null : p[1], e.getValue());
        }).sorted(Comparator.comparingLong(DistrictCount::count).reversed()
                .thenComparing(d -> d.regionCode() == null ? "" : d.regionCode())
                .thenComparing(d -> d.districtCode() == null ? "" : d.districtCode())).toList();
    }

    @Override
    public synchronized Optional<SheetRow> find(long id, ScopeSpec scope, boolean includeDeleted) {
        SheetRow r = rows.get(id);
        if (r == null || scope.isEmpty() || !scope.covers(r.regionCode(), r.districtCode())
                || r.deleted() && !includeDeleted) {
            return Optional.empty();
        }
        return Optional.of(r);
    }

    @Override
    public synchronized SheetRow insert(NewSheet sheet, LongFunction<Secrets> sealer, AuditStamp stamp) {
        long id = nextId;
        Secrets secrets = sealer == null ? Secrets.NONE : sealer.apply(id);   // 실패하면 아무것도 저장되지 않는다
        nextId++;
        String now = UTC.format(stamp.utcNow());
        Map<SheetField, Object> v = sheet.values();
        SheetRow base = new SheetRow(id, null, "", null, "", "", null, "", null, null, "", "", "", "", "", "", null, "",
                null, "", null, List.of(), 1L, false, now, now, null);
        SheetRow created = base.with(v, sheet.rounds(), secrets.phone() != null,
                secrets.phone() == null ? null : secrets.phone().last4(), secrets.sourceEnc() != null,
                secrets.sourceEnc(), 1L, now);
        rows.put(id, created);
        if (secrets.phone() != null) phones.put(id, secrets.phone());
        return created;
    }

    @Override
    public synchronized Result update(long id, Update u, long expectedVersion, ScopeSpec scope, AuditStamp stamp) {
        Optional<SheetRow> found = find(id, scope, false);
        if (found.isEmpty()) {
            return Result.of(Outcome.NOT_FOUND);
        }
        SheetRow cur = found.get();
        if (cur.rowVersion() != expectedVersion) {
            return Result.of(Outcome.CONFLICT);
        }
        Map<String, RoundEntry> merged = new LinkedHashMap<>();
        cur.rounds().forEach(r -> merged.put(r.code(), r));
        u.roundRemovals().forEach(merged::remove);
        u.roundUpserts().forEach(r -> merged.put(r.code(), r));
        SheetRow next = cur.with(u.changes(), new ArrayList<>(merged.values()), u.phoneChange(),
                u.phone() == null ? null : u.phone().last4(), u.sourceChange(), u.sourceEnc(), cur.rowVersion() + 1,
                UTC.format(stamp.utcNow()));
        rows.put(id, next);
        if (u.phoneChange()) {
            if (u.phone() == null) phones.remove(id);
            else phones.put(id, u.phone());
        }
        return Result.ok(next);
    }

    @Override
    public synchronized Result setDeleted(long id, boolean deleted, long expectedVersion, ScopeSpec scope,
            AuditStamp stamp) {
        Optional<SheetRow> found = find(id, scope, true);
        if (found.isEmpty() || found.get().deleted() == deleted) {
            return Result.of(Outcome.NOT_FOUND);
        }
        if (found.get().rowVersion() != expectedVersion) {
            return Result.of(Outcome.CONFLICT);
        }
        SheetRow next = found.get().withDeleted(deleted, expectedVersion + 1, UTC.format(stamp.utcNow()));
        rows.put(id, next);
        return Result.ok(next);
    }

    @Override
    public synchronized List<String> distinctValues(String field, ScopeSpec scope, int limit) {
        Function<SheetRow, String> get = "callResult".equals(field) ? SheetRow::callResult : SheetRow::callStatus;
        if (scope.isEmpty()) {
            return List.of();
        }
        TreeSet<String> values = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
        rows.values().stream().filter(r -> !r.deleted() && scope.covers(r.regionCode(), r.districtCode()))
                .map(get).filter(s -> !s.isEmpty()).forEach(values::add);
        return values.stream().limit(limit).toList();
    }

    private static DataScope dataScope(ScopeSpec scope) {
        return scope.unassigned() ? DataScope.allListed(scope.districts()) : DataScope.org(scope.districts());
    }

    @Override
    public boolean targetVisible(long targetId, ScopeSpec scope) {
        if (scope.isEmpty()) {
            return false;
        }
        return records.findPerson(Long.toString(targetId), dataScope(scope)).filter(p -> !p.deleted())
                .filter(p -> covers(scope, p)).isPresent();
    }

    private static boolean covers(ScopeSpec scope, Person p) {
        return scope.covers(p.str(PersonField.REGION_CODE), p.str(PersonField.DISTRICT_CODE));
    }

    @Override
    public List<Lookup> targets(String q, ScopeSpec scope, int limit) {
        if (scope.isEmpty()) {
            return List.of();
        }
        String needle = q == null ? "" : q.toLowerCase(Locale.ROOT);
        return records.searchPeople(new RecordRepository.PeopleQuery(q == null || q.isBlank() ? null : q, null, null,
                null, null, false, null, null, null, 200, 0), dataScope(scope)).stream()
                .filter(p -> !p.deleted() && covers(scope, p))
                .filter(p -> needle.isEmpty() || p.name() != null && p.name().toLowerCase(Locale.ROOT).contains(needle)
                        || p.code() != null && p.code().toLowerCase(Locale.ROOT).contains(needle))
                .limit(limit)
                .map(p -> new Lookup(p.id(), p.name(), p.code(), p.str(PersonField.REGION_CODE),
                        p.str(PersonField.DISTRICT_CODE)))
                .toList();
    }

    @Override
    public List<Lookup> members(String q, ScopeSpec scope, int limit) {
        return records.searchEmployees(q, dataScope(scope), limit).items().stream().map(entry -> {
            DistrictKey key = entry.districtKey();
            return new Lookup(entry.id(), entry.name(), entry.code(), key == null ? null : key.regionCode(),
                    key == null ? null : key.districtCode());
        }).toList();
    }

    @Override
    public boolean memberVisible(String employeeId, ScopeSpec scope) {
        return records.searchEmployees(null, dataScope(scope), 30).items().stream()
                .anyMatch(entry -> employeeId.equals(entry.id()));
    }

    @Override
    public synchronized <T> T executeBatch(Supplier<T> work) {
        Map<Long, SheetRow> before = new TreeMap<>(rows);
        Map<Long, PhoneSecret> phonesBefore = new TreeMap<>(phones);
        int auditCount = audit.size();
        try {
            return work.get();
        } catch (RuntimeException e) {
            rows.clear();
            rows.putAll(before);
            phones.clear();
            phones.putAll(phonesBefore);
            audit.subList(auditCount, audit.size()).clear();
            throw e;
        }
    }

    @Override
    public synchronized void appendAudit(AuditEntry entry, AuditStamp stamp) {
        audit.add(entry);
    }
}
