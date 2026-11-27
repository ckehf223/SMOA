package com.smoa.calling;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Supplier;

import org.springframework.stereotype.Service;

import com.smoa.access.AccessGrant;
import com.smoa.account.UnitOfWork;
import com.smoa.calling.CallingRecord.Round;
import com.smoa.calling.CallingRecord.Subject;
import com.smoa.calling.CallingRepository.Range;
import com.smoa.common.ApiException;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.program.ProgramAction;
import com.smoa.records.HistoryEntry;
import com.smoa.records.Person;
import com.smoa.records.PersonField;
import com.smoa.records.RecordRepository;
import com.smoa.records.RecordRepository.PeopleQuery;
import com.smoa.reference.ReferenceRepository;
import com.smoa.scope.ScopeEnforcer;

@Service
class CallingService {
    static final String MANAGE = "callingManage";
    static final String STATS = "callingStats";
    private static final int QUERY_LIMIT = 10_000;
    private static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");

    record Input(String personId, String date, String time, String caller, String round, String result,
            String notes, Long rowVersion) {
    }

    record View(String id, String rowVersion, String personId, String personName, String personCode, String introducer,
            String regionCode, String districtCode, String districtName, String area, String className,
            LocalDate findingDate, boolean personDeleted, boolean personUnlinked, LocalDate date, String time,
            String caller, String round, String roundLabel, String result, String resultText, String originalResult,
            String notes) {
    }

    record Page(List<View> items, int total, int offset, int limit, CallingStatistics.Summary summary) {
    }

    record RoundOption(String value, String label) {
    }

    record DistrictOption(String regionCode, String districtCode, String name) {
    }

    record Options(List<String> callers, List<RoundOption> rounds, List<String> results, List<DistrictOption> districts,
            LocalDate today, int weekStart) {
    }

    record Target(String id, String name, String code, String introducer, String regionCode, String districtCode,
            String districtName, LocalDate findingDate) {
    }

    private record Filter(Range range, String search, String caller, Round round) {
    }

    private record Query(List<CallingRecord> rows, Range range, List<Round> rounds, Map<String, String> callers) {
        CallingStatistics.Summary summary(boolean includeConnected) {
            return CallingStatistics.summarize(rows, rounds, callers, range, includeConnected);
        }
    }

    private final CallingRepository calling;
    private final RecordRepository records;
    private final ReferenceRepository reference;
    private final ScopeEnforcer enforcer;
    private final UnitOfWork work;

    CallingService(CallingRepository calling, RecordRepository records, ReferenceRepository reference,
            ScopeEnforcer enforcer, UnitOfWork work) {
        this.calling = calling;
        this.records = records;
        this.reference = reference;
        this.enforcer = enforcer;
        this.work = work;
    }

    Options options(AccessGrant grant, String program) {
        DataScope scope = scope(grant, program, ProgramAction.READ);
        var values = calling.options(scope);
        var callers = callers(values).values().stream().sorted(CallingRules.KOREAN).toList();
        var rounds = rounds(values).stream().map(r -> new RoundOption(r.value(), r.label())).toList();
        var districts = reference.districts().stream().filter(d -> scope.covers(d.key())).map(d -> new DistrictOption(
                d.key().regionCode(), d.key().districtCode(), d.name())).toList();
        return new Options(callers, rounds, CallingRules.RESULTS, districts, LocalDate.now(SEOUL), calling.weekStart());
    }

    Page page(AccessGrant grant, Map<String, String> params) {
        DataScope scope = scope(grant, MANAGE, ProgramAction.READ);
        var query = query(scope, params);
        int offset = countParam(params.get("offset"), 0, 0, QUERY_LIMIT);
        int limit = countParam(params.get("limit"), 30, 1, 100);
        int total = query.rows().size();
        var summary = "true".equals(params.get("includeSummary")) ? query.summary(true) : null;
        return new Page(views(query.rows().stream().skip(offset).limit(limit).toList()), total, offset, limit, summary);
    }

    List<View> exportRows(AccessGrant grant, Map<String, String> params) {
        return views(query(scope(grant, MANAGE, ProgramAction.EXPORT), params).rows());
    }

    CallingStatistics.Summary summary(AccessGrant grant, String program, Map<String, String> params, boolean export) {
        return query(scope(grant, program, export ? ProgramAction.EXPORT : ProgramAction.READ), params).summary(MANAGE.equals(program));
    }

    private Query query(DataScope scope, Map<String, String> params) {
        var values = calling.options(scope);
        var rounds = rounds(values);
        var callers = callers(values);
        var filter = filter(params, rounds);
        var candidates = calling.select(scope, filter.range(), QUERY_LIMIT + 1);
        if (candidates.size() > QUERY_LIMIT) {
            throw ApiException.badRequest("CALLING_RANGE_LIMIT", "조회할 콜링 기록이 많습니다. 기간 또는 구역을 좁혀 주세요.");
        }
        var districtNames = districtNames();
        var rows = candidates.stream().filter(r -> matches(r, filter, districtNames))
                .map(r -> new CallingRecord(r.id(), r.rowVersion(), r.subject(), r.date(), r.time(),
                        callers.getOrDefault(CallingRules.callerKey(CallingRules.mask(r.caller())), CallingRules.mask(r.caller())),
                        r.round(), r.outcome(), r.notes())).toList();
        if (filter.round() != null) rounds = List.of(filter.round());
        return new Query(rows, filter.range(), rounds, callers);
    }

    private static boolean matches(CallingRecord row, Filter filter, Map<DistrictKey, String> districts) {
        if (!filter.caller().isEmpty() && !CallingRules.callerKey(CallingRules.mask(row.caller())).equals(filter.caller())) return false;
        if (filter.round() != null && !filter.round().equals(row.round())) return false;
        if (filter.search().isEmpty()) return true;
        var p = row.subject();
        String area = p.district() == null ? null : districts.getOrDefault(p.district(), p.district().districtCode());
        for (String value : new String[] {p.name(), p.code(), p.introducer(), area, row.caller(), row.round().label(),
                row.outcome().result(), row.outcome().display(), row.notes()}) {
            if (CallingRules.searchKey(CallingRules.mask(value)).contains(filter.search())) return true;
        }
        return false;
    }

    private static Filter filter(Map<String, String> params, List<Round> rounds) {
        var from = CallingRules.date(params.get("from"), false);
        var to = CallingRules.date(params.get("to"), false);
        if (from != null && to != null && from.isAfter(to)) {
            throw CallingRules.invalid("조회 시작일은 종료일보다 늦을 수 없습니다.");
        }
        String region = code(params.get("regionCode"));
        String district = code(params.get("districtCode"));
        if (district != null && region == null) throw CallingRules.invalid("구역이 속한 지역을 선택해 주세요.");
        String search = CallingRules.searchKey(CallingRules.text(params.get("search"), 200, "검색어", false));
        String caller = CallingRules.callerKey(CallingRules.text(params.get("caller"), 100, "콜링자", false));
        String roundInput = params.get("round");
        Round round = roundInput == null || roundInput.isBlank() ? null : CallingRules.parseRound(roundInput, false);
        if (round != null && "5차".equals(round.name()) && !rounds.contains(round)) round = new Round(5, null);
        return new Filter(new Range(from, to, region, district), search, caller, round);
    }

    private static String code(String value) {
        if (value == null || value.isBlank()) return null;
        if (!DistrictKey.CODE.matcher(value).matches()) throw CallingRules.invalid("지역·구역을 확인해 주세요.");
        return value;
    }

    private static int countParam(String value, int fallback, int min, int max) {
        if (value == null || value.isEmpty()) return fallback;
        try {
            int n = Integer.parseInt(value);
            if (n < min || n > max) throw CallingRules.invalid("조회 페이지 범위를 확인해 주세요.");
            return n;
        } catch (NumberFormatException e) {
            throw CallingRules.invalid("조회 페이지 범위를 확인해 주세요.");
        }
    }

    private static List<Round> rounds(List<CallingRepository.Option> values) {
        Set<Round> rounds = new LinkedHashSet<>();
        for (int i = 0; i < CallingRules.ROUNDS.size(); i++) rounds.add(new Round(i, null));
        values.forEach(v -> rounds.add(v.round()));
        return rounds.stream().sorted(CallingRules.ROUND_ORDER).toList();
    }

    private static Map<String, String> callers(List<CallingRepository.Option> values) {
        Map<String, String> callers = new LinkedHashMap<>();
        values.forEach(value -> {
            String caller = CallingRules.mask(value.caller());
            if (caller != null && !caller.isBlank()) callers.putIfAbsent(CallingRules.callerKey(caller), caller);
        });
        return callers;
    }

    List<Target> targets(AccessGrant grant, String value) {
        DataScope scope = scope(grant, MANAGE, ProgramAction.WRITE);
        String q = CallingRules.text(value, 100, "대상자 검색어", false);
        var districts = districtNames();
        return records.searchPeople(new PeopleQuery(q.isBlank() ? null : q, null, null, null, null, false,
                null, null, null, 50, 0), scope).stream().filter(p -> scope.covers(p.districtKey()) && !p.deleted())
                .map(CallingService::subject).map(p -> target(p, districts)).toList();
    }

    View find(AccessGrant grant, String id) {
        return view(find(scope(grant, MANAGE, ProgramAction.READ), id), districtNames());
    }

    View save(AccessGrant grant, String id, Input input) {
        require(grant, MANAGE, ProgramAction.WRITE);
        return write(() -> {
            calling.lock();
            DataScope scope = enforcer.effectiveScope(grant);
            CallingRecord before = id == null ? null : find(scope, id);
            if (before != null) checkVersion(before, input.rowVersion());
            String targetId = input.personId();
            boolean replace = before == null || targetId != null && !Objects.equals(targetId, before.subject().id());
            Subject subject = replace ? linkedTarget(scope, targetId) : before.subject();
            CallingRecord draft = draft(input, subject, before);
            CallingRecord saved;
            if (before == null) {
                saved = draft.identity(calling.insert(draft), 0);
                audit(grant, saved, HistoryEntry.CREATED, "calling.create");
            } else {
                saved = draft.identity(before.id(), before.rowVersion());
                if (saved.equals(before)) return view(before, districtNames());
                if (!calling.update(scope, saved, replace)) throw stale();
                audit(grant, saved, HistoryEntry.UPDATED, "calling.update");
            }
            return view(find(scope, saved.id()), districtNames());
        });
    }

    void delete(AccessGrant grant, String id, Long version) {
        require(grant, MANAGE, ProgramAction.WRITE);
        write(() -> {
            calling.lock();
            var scope = enforcer.effectiveScope(grant);
            var before = find(scope, id);
            checkVersion(before, version);
            if (!calling.delete(scope, before)) throw stale();
            audit(grant, before, HistoryEntry.DELETED, "calling.delete");
            return null;
        });
    }

    <T> T write(Supplier<T> action) {
        return calling.serialized(() -> work.execute(action));
    }

    private static CallingRecord draft(Input input, Subject subject, CallingRecord previous) {
        var day = CallingRules.date(input.date(), true);
        var time = CallingRules.time(input.time());
        String caller = CallingRules.mask(CallingRules.text(input.caller(), 100, "콜링자", true));
        Round round = input.round() == null || input.round().isBlank() ? new Round(0, null)
                : CallingRules.parseRound(input.round(), false);
        var result = previous != null && Objects.equals(input.result(), CallingRules.mask(previous.outcome().display()))
                ? previous.outcome() : CallingRules.parseOutcome(input.result(), false);
        String notes = CallingRules.mask(CallingRules.text(input.notes(), 5000, "특이사항", false));
        return new CallingRecord(null, 0, subject, day, time, caller, round, result, notes.isEmpty() ? null : notes);
    }

    private Subject linkedTarget(DataScope scope, String id) {
        if (!CallingRules.id(id)) throw CallingRules.invalid("대상자를 선택해 주세요.");
        return records.findPerson(id, scope).filter(p -> scope.covers(p.districtKey()) && !p.deleted())
                .map(CallingService::subject).orElseThrow(CallingService::notFound);
    }

    static Subject subject(Person person) {
        String introducer = person.str(PersonField.INTRODUCER_NAME);
        if (introducer == null || introducer.isBlank()) introducer = person.str(PersonField.WORKER);
        String found = person.str(PersonField.FOUND_DATE);
        LocalDate date = found != null && !Boolean.TRUE.equals(person.values().get(PersonField.DATE_UNKNOWN))
                ? LocalDate.parse(found) : null;
        return new Subject(person.id(), person.name(), person.code(), introducer, person.districtKey(),
                person.str(PersonField.CLASS_NAME), date, person.deleted());
    }

    private CallingRecord find(DataScope scope, String id) {
        if (!CallingRules.id(id)) throw notFound();
        return calling.find(scope, id).filter(r -> scope.covers(r.subject().district())).orElseThrow(CallingService::notFound);
    }

    private static void checkVersion(CallingRecord row, Long version) {
        if (version == null || version < 0) throw CallingRules.invalid("콜링 기록의 버전을 확인해 주세요.");
        if (row.rowVersion() != version) throw stale();
    }

    void audit(AccessGrant grant, CallingRecord row, String type, String action) {
        records.appendHistory(new HistoryEntry(null, HistoryEntry.KIND_CHANGE, row.subject().id(), row.subject().district(),
                type, null, null, row.date().toString(), null, row.time() == null, false, null,
                grant.accountId(), grant.account().displayName(), Instant.now().toString(), action, "CALLMSTR", row.id()), null, null);
    }

    Map<DistrictKey, String> districtNames() {
        Map<DistrictKey, String> districts = new LinkedHashMap<>();
        reference.districts().forEach(d -> districts.put(d.key(), d.name()));
        return districts;
    }

    List<View> views(List<CallingRecord> rows) {
        var districts = districtNames();
        var views = new ArrayList<View>(rows.size());
        rows.forEach(row -> views.add(view(row, districts)));
        return views;
    }

    private static Target target(Subject person, Map<DistrictKey, String> districts) {
        var d = person.district();
        return new Target(person.id(), CallingRules.mask(person.name()), CallingRules.mask(person.code()),
                CallingRules.mask(person.introducer()), d == null ? null : d.regionCode(), d == null ? null : d.districtCode(),
                d == null ? null : districts.get(d), person.foundDate());
    }

    private static View view(CallingRecord record, Map<DistrictKey, String> districts) {
        var p = target(record.subject(), districts);
        var outcome = record.outcome();
        String caller = CallingRules.mask(record.caller());
        return new View(record.id(), Long.toString(record.rowVersion()), p.id(), p.name(), p.code(), p.introducer(),
                p.regionCode(), p.districtCode(), p.districtName(), p.districtName(), CallingRules.mask(record.subject().className()),
                p.findingDate(), record.subject().deleted(), p.id() == null, record.date(),
                record.time() == null ? "" : record.time().toString(), caller, record.round().value(), record.round().label(),
                outcome.result(), CallingRules.mask(outcome.display()), CallingRules.mask(outcome.original() == null
                        ? outcome.reported() : outcome.original()), CallingRules.mask(record.notes()));
    }

    private DataScope scope(AccessGrant grant, String program, ProgramAction action) {
        require(grant, program, action);
        return enforcer.effectiveScope(grant);
    }

    static void require(AccessGrant grant, String program, ProgramAction action) {
        if (!grant.canAll(program, ProgramAction.ACCESS, ProgramAction.READ, action)) {
            throw ApiException.forbidden("ACCESS_DENIED", "콜링 기능에 대한 권한이 없습니다.");
        }
    }

    private static ApiException stale() {
        return ApiException.conflict("STALE_CALLING_VERSION", "기록이 다른 곳에서 변경되었습니다. 다시 조회한 후 수정해 주세요.");
    }

    private static ApiException notFound() {
        return ApiException.notFound("콜링 기록 또는 대상자를 찾을 수 없습니다.");
    }
}
