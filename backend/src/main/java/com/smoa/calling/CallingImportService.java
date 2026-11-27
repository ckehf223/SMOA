package com.smoa.calling;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Service;

import com.smoa.access.AccessGrant;
import com.smoa.calling.CallingImportParser.Input;
import com.smoa.calling.CallingImportParser.Issue;
import com.smoa.calling.CallingImportParser.Parsed;
import com.smoa.calling.CallingRecord.Subject;
import com.smoa.calling.CallingRepository.Range;
import com.smoa.common.ApiException;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.program.ProgramAction;
import com.smoa.records.HistoryEntry;
import com.smoa.records.RecordRepository;
import com.smoa.records.RecordRepository.PeopleQuery;
import com.smoa.reference.ReferenceRepository;
import com.smoa.scope.ScopeEnforcer;

@Service
class CallingImportService {
    record Preview(String token, int totalRows, int validCount, int errorCount, int duplicateCount, int unlinkedCount,
            boolean canApply, boolean canExport, List<CallingService.View> rows, List<Issue> errors, List<String> warnings) {
    }

    record Applied(int added, int skipped) {
    }

    record ReportBody(String text, String date, String year, String caller) {
    }

    record ApplyBody(String token) {
    }

    private enum Mode { NORMAL, MIG, REPORT }

    private record RowKey(String sheet, int line) {
    }

    private record Plan(Map<RowKey, CallingRecord> usable, List<CallingRecord> exportable, List<Issue> errors, int errorCount,
            int duplicateCount, int unlinkedCount) {
    }

    private record Pending(String session, String account, String packageId, DataScope scope, Instant expires,
            Parsed parsed, Mode mode, boolean canApply, Map<RowKey, String> approvedTargets) {
        boolean ownedBy(String sessionId, AccessGrant grant) {
            return session.equals(sessionId) && account.equals(grant.accountId()) && packageId.equals(grant.packageId());
        }
    }

    private final Map<String, Pending> pending = new LinkedHashMap<>();
    private final CallingService service;
    private final CallingRepository calling;
    private final RecordRepository people;
    private final ReferenceRepository reference;
    private final ScopeEnforcer enforcer;

    CallingImportService(CallingService service, CallingRepository calling, RecordRepository people,
            ReferenceRepository reference, ScopeEnforcer enforcer) {
        this.service = service;
        this.calling = calling;
        this.people = people;
        this.reference = reference;
        this.enforcer = enforcer;
    }

    Preview excel(AccessGrant grant, String session, byte[] bytes, boolean migration) {
        requireWrite(grant);
        var parsed = CallingImportParser.workbook(bytes, migration);
        return preview(grant, session, parsed, parsed.report() ? Mode.REPORT : migration ? Mode.MIG : Mode.NORMAL);
    }

    Preview report(AccessGrant grant, String session, ReportBody input) {
        requireWrite(grant);
        return preview(grant, session, CallingReportParser.parse(input.text(), input.date(), input.year(), input.caller()), Mode.REPORT);
    }

    private Preview preview(AccessGrant grant, String session, Parsed parsed, Mode mode) {
        var scope = enforcer.effectiveScope(grant);
        var plan = plan(scope, parsed, mode);
        boolean canApply = plan.errorCount() == 0 && !plan.usable().isEmpty();
        boolean canExport = mode == Mode.REPORT && parsed.errorCount() == 0 && !plan.exportable().isEmpty()
                && grant.can(CallingService.MANAGE, ProgramAction.EXPORT);
        String token = canApply || canExport ? remember(session, grant, scope, parsed, mode, canApply, targets(plan)) : null;
        List<CallingRecord> display = plan.usable().values().stream().limit(30).toList();
        return new Preview(token, parsed.totalRows(), plan.usable().size(), plan.errorCount(), plan.duplicateCount(),
                plan.unlinkedCount(), canApply, canExport, service.views(display), plan.errors(), parsed.warnings());
    }

    Applied apply(AccessGrant grant, String session, String token) {
        requireWrite(grant);
        var original = pending(session, grant, token, true);
        return service.write(() -> {
            calling.lock();
            var scope = enforcer.effectiveScope(grant);
            verifyScope(original, scope);
            var plan = plan(scope, original.parsed(), original.mode());
            if (plan.errorCount() > 0 || !original.approvedTargets().entrySet().containsAll(targets(plan).entrySet())) {
                throw ApiException.conflict("CALLING_IMPORT_CHANGED", "대상자 또는 구역 정보가 바뀌었습니다. 다시 미리보기 해 주세요.");
            }
            for (var record : plan.usable().values()) {
                var saved = record.identity(calling.insert(record), 0);
                service.audit(grant, saved, HistoryEntry.CREATED, "calling.import");
            }
            return new Applied(plan.usable().size(), plan.duplicateCount());
        });
    }

    List<CallingService.View> convert(AccessGrant grant, String session, String token) {
        CallingService.require(grant, CallingService.MANAGE, ProgramAction.EXPORT);
        requireWrite(grant);
        var source = pending(session, grant, token, false);
        var scope = enforcer.effectiveScope(grant);
        verifyScope(source, scope);
        if (source.mode() != Mode.REPORT || source.parsed().errorCount() > 0) {
            throw CallingRules.invalid("변환할 수 있는 콜링 일보 미리보기를 만들어 주세요.");
        }
        return service.views(plan(scope, source.parsed(), source.mode()).exportable());
    }

    private Plan plan(DataScope scope, Parsed parsed, Mode mode) {
        var areaNames = service.districtNames();
        var districts = new HashMap<String, Set<DistrictKey>>();
        reference.districts().stream().filter(d -> scope.covers(d.key())).forEach(d -> {
            districts.computeIfAbsent(area(d.name()), k -> new HashSet<>()).add(d.key());
            districts.computeIfAbsent(area(d.key().districtCode()), k -> new HashSet<>()).add(d.key());
        });
        var profiles = profiles(scope, parsed.rows());
        var attempts = new HashSet<String>();
        var errors = new ArrayList<>(parsed.errors());
        var usable = new LinkedHashMap<RowKey, CallingRecord>();
        var exportable = new ArrayList<CallingRecord>();
        int errorCount = parsed.errorCount();
        int duplicates = 0;
        int unlinked = 0;
        if (!parsed.rows().isEmpty()) {
            LocalDate first = parsed.rows().stream().map(Input::date).min(LocalDate::compareTo).orElseThrow();
            LocalDate last = parsed.rows().stream().map(Input::date).max(LocalDate::compareTo).orElseThrow();
            var prior = calling.select(scope, new Range(first, last, null, null), 10_001);
            if (prior.size() > 10_000) throw CallingRules.invalid("이전 콜링 기록이 많습니다. 파일의 날짜 범위를 좁혀 주세요.");
            prior.forEach(r -> attempts.add(CallingAttempts.hash(r)));
        }
        for (Input row : parsed.rows()) {
            try {
                var name = CallingRules.text(row.personName(), 100, "대상자명", true);
                var introducer = CallingRules.text(row.introducer(), 100, "인도자", false);
                var areaKey = area(CallingRules.text(row.area(), 60, "구역", false));
                var code = CallingRules.searchKey(CallingRules.text(row.personCode(), 60, "대상자ID", false));
                var found = profiles.getOrDefault(CallingRules.searchKey(name), List.of()).stream()
                        .filter(p -> code.isEmpty() || CallingRules.searchKey(p.code()).equals(code))
                        .filter(p -> introducer.isEmpty() || CallingRules.searchKey(p.introducer()).equals(CallingRules.searchKey(introducer)))
                        .filter(p -> areaKey.isEmpty() || p.district() != null && (area(areaNames.get(p.district())).equals(areaKey)
                                || area(p.district().districtCode()).equals(areaKey))).toList();
                Subject subject;
                boolean unresolved = found.size() != 1;
                if (unresolved) {
                    var possible = districts.getOrDefault(areaKey, Set.of());
                    if (mode == Mode.NORMAL || !code.isEmpty() || possible.size() != 1) {
                        throw CallingRules.invalid(found.isEmpty()
                                ? "권한 범위 내 대상자의 이름·인도자·구역을 확인해 주세요."
                                : "동명이인을 구분할 수 없습니다. 인도자·구역 또는 대상자ID를 입력해 주세요.");
                    }
                    DistrictKey key = possible.iterator().next();
                    subject = new Subject(null, CallingRules.mask(name), null, CallingRules.mask(introducer), key, null, null, false);
                } else {
                    subject = found.getFirst();
                }
                var round = CallingRules.parseRound(row.round(), parsed.legacyFifth());
                var outcome = CallingRules.parseOutcome(row.result(), mode == Mode.MIG);
                var caller = CallingRules.mask(CallingRules.text(row.caller(), 100, "콜링자", true));
                var note = CallingRules.mask(CallingRules.text(row.notes(), 5000, "특이사항", false));
                var record = new CallingRecord(null, 0, subject, row.date(), row.time(), caller, round, outcome, note);
                String hash = CallingAttempts.hash(record);
                var unlinkedAttempt = new CallingRecord(null, 0, new Subject(null, name, null, introducer, subject.district(), null, null, false),
                        row.date(), row.time(), caller, round, outcome, note);
                if (attempts.contains(hash) || mode == Mode.REPORT && !unresolved && attempts.contains(CallingAttempts.hash(unlinkedAttempt))) {
                    duplicates++;
                    continue;
                }
                attempts.add(hash);
                if (mode == Mode.REPORT) exportable.add(record);
                if (unresolved && mode == Mode.REPORT) throw CallingRules.invalid("대상자를 한 명으로 확인해 주세요. 일보를 엑셀로 변환할 수 있습니다.");
                if (unresolved) unlinked++;
                usable.put(new RowKey(row.sheet(), row.row()), record);
            } catch (ApiException e) {
                errorCount++;
                if (errors.size() < 50) errors.add(new Issue(row.sheet(), row.row(), e.getMessage()));
            }
        }
        return new Plan(usable, exportable, errors, errorCount, duplicates, unlinked);
    }

    private Map<String, List<Subject>> profiles(DataScope scope, List<Input> inputs) {
        if (inputs.isEmpty()) return Map.of();
        Set<String> names = new HashSet<>();
        inputs.forEach(i -> names.add(CallingRules.searchKey(i.personName())));
        Map<String, List<Subject>> profiles = new HashMap<>();
        var all = people.searchPeople(new PeopleQuery(null, null, null, null, null, false, null, null, null,
                10_001, 0), scope);
        if (all.size() > 10_000) throw CallingRules.invalid("가져오기에 필요한 대상자 수가 많아 대상자를 확인할 수 없습니다.");
        all.stream().filter(p -> scope.covers(p.districtKey()) && !p.deleted() && names.contains(CallingRules.searchKey(p.name())))
                .map(CallingService::subject).forEach(p -> profiles.computeIfAbsent(CallingRules.searchKey(p.name()),
                        k -> new ArrayList<>()).add(p));
        return profiles;
    }

    private static String area(String name) {
        return CallingRules.searchKey(name).replaceFirst("^(\\d+)구역$", "$1").replaceFirst("^0+(?=\\d+$)", "");
    }

    private static Map<RowKey, String> targets(Plan plan) {
        var ids = new HashMap<RowKey, String>();
        plan.usable().forEach((key, row) -> ids.put(key, CallingAttempts.targetKey(row)));
        return ids;
    }

    private synchronized String remember(String session, AccessGrant grant, DataScope scope, Parsed parsed, Mode mode,
            boolean canApply, Map<RowKey, String> approvedTargets) {
        prune();
        pending.entrySet().removeIf(e -> e.getValue().session().equals(session));
        if (pending.size() >= 12) pending.remove(pending.keySet().iterator().next());
        String token = UUID.randomUUID().toString();
        pending.put(token, new Pending(session, grant.accountId(), grant.packageId(), scope,
                Instant.now().plusSeconds(15 * 60), parsed, mode, canApply, approvedTargets));
        return token;
    }

    private synchronized Pending pending(String session, AccessGrant grant, String token, boolean consume) {
        prune();
        var saved = token == null ? null : pending.get(token);
        if (saved == null || !saved.ownedBy(session, grant)) {
            throw ApiException.notFound("가져오기 미리보기가 만료되었거나 이미 적용되었습니다.");
        }
        if (consume) {
            if (!saved.canApply()) throw CallingRules.invalid("오류가 없는 콜링 미리보기를 적용해 주세요.");
            pending.remove(token);
        }
        return saved;
    }

    private void prune() {
        Instant now = Instant.now();
        pending.values().removeIf(p -> !p.expires().isAfter(now));
    }

    private static void verifyScope(Pending source, DataScope scope) {
        if (!source.scope().equals(scope)) {
            throw ApiException.conflict("CALLING_IMPORT_CHANGED", "접근할 수 있는 구역이 변경되었습니다. 다시 미리보기 해 주세요.");
        }
    }

    private static void requireWrite(AccessGrant grant) {
        CallingService.require(grant, CallingService.MANAGE, ProgramAction.WRITE);
    }
}
