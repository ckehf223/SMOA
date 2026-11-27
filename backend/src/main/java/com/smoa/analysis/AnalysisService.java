package com.smoa.analysis;

import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import com.smoa.access.AccessGrant;
import com.smoa.analysis.AnalysisData.Activity;
import com.smoa.analysis.AnalysisData.Filter;
import com.smoa.analysis.AnalysisData.Finding;
import com.smoa.analysis.AnalysisData.Rows;
import com.smoa.common.ApiException;
import com.smoa.config.LibraryContext;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.permission.ScopeType;
import com.smoa.program.ProgramAction;
import com.smoa.records.ActivityField;
import com.smoa.records.PersonField;
import com.smoa.records.RecordRepository;
import com.smoa.records.RecordRepository.ActivityQuery;
import com.smoa.records.RecordRepository.PeopleQuery;
import com.smoa.reference.ReferenceRepository;
import com.smoa.scope.ScopeEnforcer;

@Service
class AnalysisService {
    static final String FINDINGS = "findingStats";
    static final String DIAGNOSTICS = "diagnostics";
    static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
    private static final int MEMORY_PAGE_SIZE = 200;

    record DistrictOption(String regionCode, String districtCode, String name) {}

    private final ObjectProvider<LibraryContext> library;
    private final ObjectProvider<AnalysisMapper> mapper;
    private final RecordRepository records;
    private final ScopeEnforcer enforcer;
    private final ReferenceRepository reference;

    AnalysisService(ObjectProvider<LibraryContext> library, ObjectProvider<AnalysisMapper> mapper,
            RecordRepository records, ScopeEnforcer enforcer, ReferenceRepository reference) {
        this.library = library;
        this.mapper = mapper;
        this.records = records;
        this.enforcer = enforcer;
        this.reference = reference;
    }

    List<DistrictOption> districts(AccessGrant grant, String program) {
        require(grant, program, ProgramAction.READ);
        return districtNames(enforcer.effectiveScope(grant)).entrySet().stream()
                .map(e -> new DistrictOption(e.getKey().regionCode(), e.getKey().districtCode(), e.getValue())).toList();
    }

    FindingAnalysis.Summary finding(AccessGrant grant, String from, String to, String region, String district, String job) {
        require(grant, FINDINGS, ProgramAction.READ);
        Filter filter = filter(date(from), date(to), region, district, true);
        job = FindingAnalysis.clean(job);
        if (job != null && job.length() > 60) throw ApiException.badRequest("INVALID_JOB", "직업 구분을 확인하세요.");
        DataScope scope = enforcer.effectiveScope(grant);
        return FindingAnalysis.summarize(filter, read(scope, filter), districtNames(scope), job);
    }

    DiagnosticsAnalysis.Summary diagnostics(AccessGrant grant, String anchor, String kind, String region, String district) {
        require(grant, DIAGNOSTICS, ProgramAction.READ);
        LocalDate today = LocalDate.now(SEOUL);
        LocalDate selected = date(anchor);
        if (selected == null) selected = today;
        if (selected.isAfter(today)) throw ApiException.badRequest("INVALID_PERIOD", "오늘까지의 기간을 선택하세요.");
        boolean monthly = "month".equals(kind);
        if (kind != null && !kind.equals("week") && !monthly) throw ApiException.badRequest("INVALID_PERIOD", "주 또는 월을 선택하세요.");
        List<DiagnosticsAnalysis.Period> periods = DiagnosticsAnalysis.periods(selected, today, monthly);
        Filter filter = filter(periods.getLast().from(), periods.getFirst().to(), region, district, false);
        DataScope scope = enforcer.effectiveScope(grant);
        return DiagnosticsAnalysis.summarize(periods, read(scope, filter), filter, today, districtNames(scope));
    }

    private Map<DistrictKey, String> districtNames(DataScope scope) {
        Map<String, String> regions = new LinkedHashMap<>();
        reference.regions().forEach(region -> regions.put(region.regionCode(), region.name()));
        Map<DistrictKey, String> names = new LinkedHashMap<>();
        reference.districts().stream().filter(d -> scope.covers(d.key())).forEach(district ->
                names.put(district.key(), regions.getOrDefault(district.key().regionCode(), district.key().regionCode()) + " / " + district.name()));
        return names;
    }

    private Rows read(DataScope scope, Filter filter) {
        if (scope.isEmptyAssignment()) return new Rows(List.of(), List.of());
        LibraryContext db = library.getIfAvailable();
        if (db == null) return readMemory(scope, filter);
        AnalysisMapper sql = mapper.getObject();
        boolean unassigned = scope.type() == ScopeType.ALL;
        var districts = scope.districts().stream().sorted().toList();
        return new Rows(sql.selectFindings(db.id(), filter, districts, unassigned),
                sql.selectActivities(db.id(), filter, districts, unassigned));
    }

    private Rows readMemory(DataScope scope, Filter filter) {
        var findings = new ArrayList<Finding>();
        var activities = new ArrayList<Activity>();
        for (int offset = 0; ; offset += MEMORY_PAGE_SIZE) {
            var page = records.searchPeople(new PeopleQuery(null, filter.regionCode(), filter.districtCode(),
                    null, null, false, null, null, null, MEMORY_PAGE_SIZE, offset), scope);
            for (var person : page) {
                String classification = person.str(PersonField.CLASSIFICATION2);
                if (filter.roadOnly() && !"노방".equals(classification)) continue;
                var found = Boolean.TRUE.equals(person.values().get(PersonField.DATE_UNKNOWN)) ? null : date(person.str(PersonField.FOUND_DATE));
                var manpik = date(person.str(PersonField.MANPIK_DATE));
                if (!filter.includes(found) && (filter.roadOnly() || !filter.includes(manpik))) continue;
                findings.add(new Finding(found, time(person.str(PersonField.FOUND_TIME)), person.str(PersonField.REGION_CODE),
                        person.str(PersonField.DISTRICT_CODE), person.str(PersonField.PLACE), classification, manpik,
                        date(person.str(PersonField.FIND_A_DATE))));
            }
            if (page.size() < MEMORY_PAGE_SIZE) break;
        }
        for (int offset = 0; ; offset += MEMORY_PAGE_SIZE) {
            var page = records.searchActivities(new ActivityQuery(null, null, filter.regionCode(), filter.districtCode(),
                    filter.from() == null ? null : filter.from().minusDays(1).toString(), filter.to() == null ? null : filter.to().toString(),
                    MEMORY_PAGE_SIZE, offset), scope);
            for (var row : page) {
                var classification = row.str(ActivityField.CLASSIFICATION2);
                if (classification != null && !classification.equals("노방")) continue;
                activities.add(new Activity(date(row.date()), time(row.str(ActivityField.START_TIME)), time(row.str(ActivityField.END_TIME)),
                        row.str(ActivityField.REGION_CODE), row.str(ActivityField.DISTRICT_CODE), row.str(ActivityField.WORKER_ID),
                        row.str(ActivityField.WORKER_CODE), row.str(ActivityField.WORKER), null, row.str(ActivityField.PLACE),
                        row.str(ActivityField.SESSION_KEY), row.str(ActivityField.MEMO)));
            }
            if (page.size() < MEMORY_PAGE_SIZE) break;
        }
        return new Rows(findings, activities);
    }

    private static Filter filter(LocalDate from, LocalDate to, String region, String district, boolean roadOnly) {
        region = FindingAnalysis.clean(region);
        district = FindingAnalysis.clean(district);
        if ((region != null || district != null) && !DistrictKey.valid(region, district)) {
            throw ApiException.badRequest("INVALID_DISTRICT", "지역과 구역을 함께 선택하세요.");
        }
        if (from != null && to != null && (from.isAfter(to) || from.plusYears(10).isBefore(to))) {
            throw ApiException.badRequest("INVALID_PERIOD", "조회 기간은 시작일부터 10년 이내로 지정하세요.");
        }
        return new Filter(from, to, region, district, roadOnly);
    }

    private static LocalTime time(String value) {
        return value == null || value.isBlank() ? null : LocalTime.parse(value);
    }

    private static LocalDate date(String value) {
        if (value == null || value.isBlank()) return null;
        try {
            LocalDate date = LocalDate.parse(value);
            if (date.getYear() >= 1900 && date.getYear() <= 2200) return date;
        } catch (DateTimeException ignored) {
            // 아래에서 입력값을 노출하지 않는 검증 오류를 반환한다.
        }
        throw ApiException.badRequest("INVALID_PERIOD", "날짜를 확인하세요.");
    }

    static void require(AccessGrant grant, String program, ProgramAction action) {
        if (!grant.can(program, action)) throw ApiException.forbidden("ACTION_DENIED", "이 동작에 대한 권한이 없습니다.");
    }
}
