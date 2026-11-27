package com.smoa.records.memory;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;

import com.smoa.crypto.ContactVault.PhoneSecret;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.records.Activity;
import com.smoa.records.ActivityField;
import com.smoa.records.HistoryEntry;
import com.smoa.records.Person;
import com.smoa.records.PersonField;
import com.smoa.records.RecordRepository;

/**
 * local-memory 전용 가상 업무 자료 저장소. 서버를 종료하면 사라진다. DB 구현과 같은 계약(범위·ROW_VERSION·부분 수정)을 지킨다.
 * 연락처 봉투는 메모리에만 두며 어떤 조회에서도 돌려주지 않는다.
 */
@Repository
@Profile("local-memory")
public class MemoryRecordRepository implements RecordRepository {

    /** 가상 단계 코드(local-memory 전용). DB 모드에서는 CODEDTL 의 STAGE 그룹을 읽는다. */
    public static final List<String> VIRTUAL_STAGES = List.of("찾B", "콜링", "만픽", "찾A", "합 B", "복음방", "신카접수", "센터등록");

    private final AtomicLong personSeq = new AtomicLong();
    private final AtomicLong activitySeq = new AtomicLong();
    private final AtomicLong historySeq = new AtomicLong();
    private final Map<String, Person> persons = new LinkedHashMap<>();
    private final Map<String, String> phoneEnvelopes = new HashMap<>();
    private final Map<String, Activity> activities = new LinkedHashMap<>();
    private final List<HistoryEntry> historyList = new ArrayList<>();

    @Override
    public Map<String, List<CodeItem>> codes() {
        List<CodeItem> stages = new ArrayList<>();
        for (int i = 0; i < VIRTUAL_STAGES.size(); i++) {
            stages.add(new CodeItem(VIRTUAL_STAGES.get(i), VIRTUAL_STAGES.get(i), i, true));
        }
        return Map.of("STAGE", stages);
    }

    @Override
    public boolean employeeExists(String employeeId, DataScope scope) {
        return VIRTUAL_EMPLOYEES.stream().anyMatch(e -> e.id().equals(employeeId) && scope.covers(e.districtKey()));
    }

    /** 가상 조직원 명부(local-memory 전용): 같은 이름이 둘이어도 ID 로 구별한다. */
    private static final List<EmployeeOption> VIRTUAL_EMPLOYEES = List.of(
            new EmployeeOption("E-VIRT-1", "M-1001", "가상인도자", new DistrictKey("R1", "D1")),
            new EmployeeOption("E-VIRT-2", "M-1002", "가상인도자", new DistrictKey("R1", "D1")),
            new EmployeeOption("E-VIRT-3", "M-2001", "다른구역인도자", new DistrictKey("R2", "D1")),
            new EmployeeOption("E-VIRT-4", null, "미배정인도자", null));

    @Override
    public EmployeePage searchEmployees(String q, DataScope scope, int limit) {
        String needle = q == null ? "" : q.toLowerCase(Locale.ROOT);
        List<EmployeeOption> all = VIRTUAL_EMPLOYEES.stream().filter(e -> scope.covers(e.districtKey()))
                .filter(e -> needle.isEmpty() || e.name().toLowerCase(Locale.ROOT).contains(needle)
                        || e.code() != null && e.code().toLowerCase(Locale.ROOT).contains(needle))
                .toList();
        return new EmployeePage(all.stream().limit(Math.max(1, limit)).toList(), all.size());
    }

    // ---- 대상자 ----

    @Override
    public synchronized List<Person> searchPeople(PeopleQuery q, DataScope scope) {
        return matchingPeople(q, scope).skip(q.offset()).limit(q.limit()).toList();
    }


    public synchronized long countPeople(PeopleQuery q, DataScope scope) {
        return matchingPeople(q, scope).count();
    }

    private java.util.stream.Stream<Person> matchingPeople(PeopleQuery q, DataScope scope) {
        String needle = q.q() == null ? "" : q.q().toLowerCase(Locale.ROOT);
        return persons.values().stream()
                .filter(p -> scope.covers(p.districtKey()))
                .filter(p -> q.includeDeleted() || !p.deleted())
                .filter(p -> blank(q.regionCode()) || q.regionCode().equals(p.str(PersonField.REGION_CODE)))
                .filter(p -> blank(q.districtCode()) || q.districtCode().equals(p.str(PersonField.DISTRICT_CODE)))
                .filter(p -> blank(q.stageId()) || q.stageId().equals(p.stageId()))
                .filter(p -> blank(q.status()) || q.status().equals(p.status()))
                .filter(p -> blank(q.phoneLast4()) || q.phoneLast4().equals(p.phoneLast4()))
                .filter(p -> blank(q.foundFrom()) || p.str(PersonField.FOUND_DATE) != null
                        && p.str(PersonField.FOUND_DATE).compareTo(q.foundFrom()) >= 0)
                .filter(p -> blank(q.foundTo()) || p.str(PersonField.FOUND_DATE) != null
                        && p.str(PersonField.FOUND_DATE).compareTo(q.foundTo()) <= 0)
                .filter(p -> needle.isEmpty() || p.name().toLowerCase(Locale.ROOT).contains(needle)
                        || p.code() != null && p.code().toLowerCase(Locale.ROOT).contains(needle))
                .sorted(Comparator.comparing(Person::name).thenComparing(p -> Long.parseLong(p.id())));
    }

    @Override
    public synchronized Optional<Person> findPerson(String id, DataScope scope) {
        return Optional.ofNullable(persons.get(id)).filter(p -> scope.covers(p.districtKey()));
    }

    @Override
    public synchronized Person insertPerson(Person person) {
        String id = Long.toString(personSeq.incrementAndGet());
        String now = now();
        Person saved = person.withMeta(id, 1L, now, now);
        persons.put(id, saved);
        return saved;
    }

    @Override
    public synchronized WriteResult<Person> updatePerson(String id, Map<PersonField, Object> changes,
            PhoneUpdate phone, long expectedVersion, DataScope scope) {
        Person current = persons.get(id);
        if (current == null || !scope.covers(current.districtKey())) {
            return WriteResult.of(Outcome.NOT_FOUND);
        }
        if (current.rowVersion() != expectedVersion) {
            return WriteResult.of(Outcome.CONFLICT);
        }
        Person next = current.with(changes);
        if (phone.change()) {
            if (phone.secret() == null) {
                next = next.withPhone(null, false);
                phoneEnvelopes.remove(id);
            } else {
                next = next.withPhone(phone.secret().last4(), true);
                phoneEnvelopes.put(id, phone.secret().envelope());
            }
        }
        next = next.withMeta(id, current.rowVersion() + 1, current.createdAt(), now());
        persons.put(id, next);
        return WriteResult.ok(next);
    }

    @Override
    public synchronized void attachInitialPhone(String id, PhoneSecret secret) {
        Person current = persons.get(id);
        if (current == null || phoneEnvelopes.containsKey(id)) {
            return;
        }
        phoneEnvelopes.put(id, secret.envelope());
        persons.put(id, current.withPhone(secret.last4(), true));
    }

    @Override
    public Optional<String> migrationSourceId(String personId) {
        return Optional.empty();
    }

    // ---- 활동 ----

    @Override
    public synchronized List<Activity> searchActivities(ActivityQuery q, DataScope scope) {
        return matchingActivities(q, scope).skip(q.offset()).limit(q.limit()).toList();
    }


    public synchronized long countActivities(ActivityQuery q, DataScope scope) {
        return matchingActivities(q, scope).count();
    }


    public synchronized ActivityTotals summarizeActivities(ActivityQuery q, DataScope scope) {
        List<Activity> rows = matchingActivities(q, scope).toList();
        long personCount = rows.stream().filter(a -> !a.standalone()).count();
        long personMinutes = rows.stream().filter(a -> !a.standalone()).mapToLong(Activity::minutes).sum();
        long standaloneMinutes = rows.stream().filter(Activity::standalone).mapToLong(Activity::minutes).sum();
        return new ActivityTotals(personCount, personMinutes, rows.size() - personCount, standaloneMinutes);
    }

    private java.util.stream.Stream<Activity> matchingActivities(ActivityQuery q, DataScope scope) {
        return activities.values().stream()
                .filter(a -> scope.covers(a.districtKey()))
                .filter(a -> !a.deleted())
                .filter(a -> blank(q.personId()) || q.personId().equals(a.personId()))
                .filter(a -> q.standalone() == null || q.standalone() == a.standalone())
                .filter(a -> blank(q.regionCode()) || q.regionCode().equals(a.str(ActivityField.REGION_CODE)))
                .filter(a -> blank(q.districtCode()) || q.districtCode().equals(a.str(ActivityField.DISTRICT_CODE)))
                .filter(a -> blank(q.from()) || a.date().compareTo(q.from()) >= 0)
                .filter(a -> blank(q.to()) || a.date().compareTo(q.to()) <= 0)
                .sorted(Comparator.comparing(Activity::date).thenComparing(a -> Long.parseLong(a.id())));
    }

    @Override
    public synchronized Optional<Activity> findActivity(String id, DataScope scope) {
        return Optional.ofNullable(activities.get(id)).filter(a -> scope.covers(a.districtKey()));
    }

    @Override
    public synchronized Activity insertActivity(Activity activity) {
        String id = Long.toString(activitySeq.incrementAndGet());
        String now = now();
        Activity saved = activity.withMeta(id, 1L, now, now);
        activities.put(id, saved);
        return saved;
    }

    @Override
    public synchronized WriteResult<Activity> updateActivity(String id, Map<ActivityField, Object> changes,
            long expectedVersion, DataScope scope) {
        Activity current = activities.get(id);
        if (current == null || !scope.covers(current.districtKey())) {
            return WriteResult.of(Outcome.NOT_FOUND);
        }
        if (current.rowVersion() != expectedVersion) {
            return WriteResult.of(Outcome.CONFLICT);
        }
        Activity next = current.with(changes).withMeta(id, current.rowVersion() + 1, current.createdAt(), now());
        activities.put(id, next);
        return WriteResult.ok(next);
    }

    // ---- 이력 ----

    @Override
    public synchronized void appendHistory(HistoryEntry entry, String beforeJson, String afterJson) {
        historyList.add(new HistoryEntry(Long.toString(historySeq.incrementAndGet()), entry.kind(), entry.personId(),
                entry.districtKey(), entry.type(), entry.fromValue(), entry.toValue(), entry.effectiveDate(),
                entry.effectiveAt(), entry.timeUnknown(), entry.baseline(), entry.reason(), entry.actorAccountId(),
                entry.actorName(), entry.recordedAt(), entry.action(), entry.targetKind(), entry.targetId()));
    }

    @Override
    public synchronized HistoryPage history(HistoryQuery q, DataScope scope) {
        List<HistoryEntry> rows = historyList.stream().filter(h -> scope.covers(h.districtKey()))
                .filter(h -> !HistoryEntry.duplicatesLifecycleLog(h))
                .filter(h -> blank(q.personId()) || q.personId().equals(h.personId()))
                .filter(h -> blank(q.kind()) || q.kind().equals(h.kind()))
                .filter(h -> blank(q.from()) || h.effectiveDate() != null && h.effectiveDate().compareTo(q.from()) >= 0)
                .filter(h -> blank(q.to()) || h.effectiveDate() != null && h.effectiveDate().compareTo(q.to()) <= 0)
                .sorted(Comparator.comparing((HistoryEntry h) -> h.effectiveAt() == null ? h.recordedAt() : h.effectiveAt(),
                        Comparator.nullsFirst(Comparator.<String>naturalOrder()))
                        .thenComparing(h -> Long.parseLong(h.id())).reversed())
                .toList();
        return new HistoryPage(rows.stream().skip(q.offset()).limit(q.limit()).toList(), rows.size());
    }

    @Override
    public synchronized Map<String, Long> stageTransitions(StageQuery q, DataScope scope) {
        Map<String, Long> counts = new LinkedHashMap<>();
        historyList.stream().filter(h -> HistoryEntry.KIND_STAGE.equals(h.kind()) && !h.baseline())
                .filter(h -> scope.covers(h.districtKey()))
                .filter(h -> blank(q.regionCode()) || h.districtKey() != null && q.regionCode().equals(h.districtKey().regionCode()))
                .filter(h -> blank(q.districtCode()) || h.districtKey() != null && q.districtCode().equals(h.districtKey().districtCode()))
                .filter(h -> h.effectiveDate() != null)
                .filter(h -> blank(q.from()) || h.effectiveDate().compareTo(q.from()) >= 0)
                .filter(h -> blank(q.to()) || h.effectiveDate().compareTo(q.to()) <= 0)
                .forEach(h -> counts.merge((h.fromValue() == null ? "-" : h.fromValue()) + " → "
                        + (h.toValue() == null ? "-" : h.toValue()), 1L, Long::sum));
        return counts;
    }

    /** 테스트 확인용: 저장된 연락처 봉투(원문 아님). 운영 API 에는 노출하지 않는다. */
    public synchronized Optional<String> phoneEnvelopeOf(String personId) {
        return Optional.ofNullable(phoneEnvelopes.get(personId));
    }

    /** 가상 업무 자료 초기화(테스트·로컬 전용). */
    public synchronized void clear() {
        persons.clear();
        phoneEnvelopes.clear();
        activities.clear();
        historyList.clear();
    }

    private static String now() {
        return Instant.now().truncatedTo(ChronoUnit.SECONDS).toString();
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

}
