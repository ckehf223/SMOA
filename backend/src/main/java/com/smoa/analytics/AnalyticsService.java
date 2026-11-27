package com.smoa.analytics;

import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import com.smoa.access.AccessGrant;
import com.smoa.common.ApiException;
import com.smoa.config.LibraryContext;
import com.smoa.module.mapper.AnalyticsMapper;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.permission.ScopeType;
import com.smoa.records.PersonField;
import com.smoa.records.RecordRepository;
import com.smoa.records.RecordRepository.ActivityQuery;
import com.smoa.records.RecordRepository.PeopleQuery;
import com.smoa.reference.ReferenceRepository;
import com.smoa.scope.ScopeEnforcer;

@Service
public class AnalyticsService {

    public record Query(String from, String to, String regionCode, String districtCode) {}
    public record DistrictOption(String regionCode, String districtCode, String name) {}
    public record DistrictTotals(String name, long people, long dropped, long findings, long activities, long minutes) {}
    public record StageTotal(String stage, long total) {}
    public record DayTotal(String day, long total) {}
    public record Dashboard(Query period, DistrictTotals totals, List<DistrictTotals> districts,
            List<StageTotal> stages, List<DayTotal> days) {}

    private final ObjectProvider<LibraryContext> library;
    private final ObjectProvider<AnalyticsMapper> mapper;
    private final RecordRepository records;
    private final ScopeEnforcer enforcer;
    private final ReferenceRepository reference;

    public AnalyticsService(ObjectProvider<LibraryContext> library, ObjectProvider<AnalyticsMapper> mapper,
            RecordRepository records, ScopeEnforcer enforcer, ReferenceRepository reference) {
        this.library = library;
        this.mapper = mapper;
        this.records = records;
        this.enforcer = enforcer;
        this.reference = reference;
    }

    public List<DistrictOption> districts(AccessGrant grant) {
        return districtNames(enforcer.effectiveScope(grant)).entrySet().stream()
                .map(e -> new DistrictOption(e.getKey().regionCode(), e.getKey().districtCode(), e.getValue()))
                .toList();
    }

    public Dashboard dashboard(AccessGrant grant, String from, String to, String region, String district) {
        Query query = period(from, to, region, district);
        DataScope scope = enforcer.effectiveScope(grant);
        Map<DistrictKey, String> names = districtNames(scope);
        List<Map<String, Object>> people = new ArrayList<>();
        List<Map<String, Object>> activities = new ArrayList<>();
        if (!scope.isEmptyAssignment()) {
            LibraryContext db = library.getIfAvailable();
            if (db == null) {
                readMemory(query, scope, people, activities);
            } else {
                AnalyticsMapper sql = mapper.getObject();
                boolean unassigned = scope.type() == ScopeType.ALL;
                List<DistrictKey> districts = List.copyOf(scope.districts());
                people = sql.selectPeopleMetrics(db.id(), query, districts, unassigned);
                activities = sql.selectActivityMetrics(db.id(), query, districts, unassigned);
            }
        }
        return summarize(query, names, people, activities);
    }

    static Query period(String from, String to, String region, String district) {
        LocalDate today = LocalDate.now(ZoneId.of("Asia/Seoul"));
        LocalDate end = date(to, today);
        LocalDate start = date(from, end.withDayOfMonth(1));
        if (start.isAfter(end) || start.plusDays(365).isBefore(end)) {
            throw ApiException.badRequest("INVALID_PERIOD", "조회 기간을 1년 이내로 지정하세요.");
        }
        if ((region != null || district != null) && !DistrictKey.valid(region, district)) {
            throw ApiException.badRequest("INVALID_DISTRICT", "지역과 구역을 함께 선택하세요.");
        }
        return new Query(start.toString(), end.toString(), region, district);
    }

    Map<DistrictKey, String> districtNames(DataScope scope) {
        Map<String, String> regions = new LinkedHashMap<>();
        reference.regions().forEach(r -> regions.put(r.regionCode(), r.name()));
        Map<DistrictKey, String> names = new LinkedHashMap<>();
        reference.districts().stream().filter(d -> scope.covers(d.key()))
                .sorted(Comparator.comparing(d -> d.name(), java.text.Collator.getInstance(java.util.Locale.KOREAN)))
                .forEach(d -> names.put(d.key(), regions.getOrDefault(d.key().regionCode(), d.key().regionCode()) + " / " + d.name()));
        return names;
    }

    private void readMemory(Query query, DataScope scope, List<Map<String, Object>> people,
            List<Map<String, Object>> activities) {
        final int batchSize = 200;
        for (int offset = 0; ; offset += batchSize) {
            var page = records.searchPeople(new PeopleQuery(null, query.regionCode(), query.districtCode(),
                    null, null, false, null, null, null, batchSize, offset), scope);
            page.forEach(person -> {
                Map<String, Object> row = new LinkedHashMap<>();
                putDistrict(row, person.districtKey());
                row.put("stage", person.stageId());
                row.put("day", person.str(PersonField.FOUND_DATE));
                row.put("total", 1L);
                row.put("dropped", "dropped".equals(person.status()) ? 1L : 0L);
                people.add(row);
            });
            if (page.size() < batchSize) break;
        }
        for (int offset = 0; ; offset += batchSize) {
            var page = records.searchActivities(new ActivityQuery(null, null, query.regionCode(), query.districtCode(),
                    query.from(), query.to(), batchSize, offset), scope);
            page.forEach(activity -> {
                Map<String, Object> row = new LinkedHashMap<>();
                putDistrict(row, activity.districtKey());
                row.put("total", 1L);
                row.put("minutes", (long) activity.minutes());
                activities.add(row);
            });
            if (page.size() < batchSize) break;
        }
    }

    private static Dashboard summarize(Query period, Map<DistrictKey, String> names,
            List<Map<String, Object>> people, List<Map<String, Object>> activities) {
        Map<DistrictKey, Totals> districts = new LinkedHashMap<>();
        names.forEach((key, name) -> {
            if (period.regionCode() == null || key.equals(new DistrictKey(period.regionCode(), period.districtCode()))) {
                districts.put(key, new Totals(name));
            }
        });
        Totals overall = new Totals("합계");
        Map<String, Long> stages = new TreeMap<>();
        Map<String, Long> days = new LinkedHashMap<>();
        LocalDate.parse(period.from()).datesUntil(LocalDate.parse(period.to()).plusDays(1))
                .forEach(day -> days.put(day.toString(), 0L));
        for (Map<String, Object> row : people) {
            long total = number(row, "total");
            long dropped = number(row, "dropped");
            String day = (String) row.get("day");
            boolean inPeriod = day != null && days.containsKey(day);
            Totals group = district(row, districts);
            group.people += total;
            group.dropped += dropped;
            overall.people += total;
            overall.dropped += dropped;
            String stage = (String) row.get("stage");
            stages.merge(stage == null ? "단계 미지정" : stage, total, Long::sum);
            if (inPeriod) {
                days.merge(day, total, Long::sum);
                group.findings += total;
                overall.findings += total;
            }
        }
        for (Map<String, Object> row : activities) {
            long total = number(row, "total");
            long minutes = number(row, "minutes");
            Totals group = district(row, districts);
            group.activities += total;
            group.minutes += minutes;
            overall.activities += total;
            overall.minutes += minutes;
        }
        return new Dashboard(period, overall.view(), districts.values().stream().map(Totals::view).toList(),
                stages.entrySet().stream().map(e -> new StageTotal(e.getKey(), e.getValue())).toList(),
                days.entrySet().stream().map(e -> new DayTotal(e.getKey(), e.getValue())).toList());
    }

    private static Totals district(Map<String, Object> row, Map<DistrictKey, Totals> districts) {
        String region = (String) row.get("regionCode");
        String district = (String) row.get("districtCode");
        DistrictKey key = DistrictKey.valid(region, district) ? new DistrictKey(region, district) : null;
        return districts.computeIfAbsent(key, ignored -> new Totals("구역 미지정"));
    }

    private static void putDistrict(Map<String, Object> row, DistrictKey district) {
        if (district == null) return;
        row.put("regionCode", district.regionCode());
        row.put("districtCode", district.districtCode());
    }

    private static long number(Map<String, Object> row, String key) {
        return ((Number) row.get(key)).longValue();
    }

    private static LocalDate date(String value, LocalDate fallback) {
        if (value == null || value.isBlank()) return fallback;
        try {
            LocalDate date = LocalDate.parse(value);
            if (date.getYear() < 1900 || date.getYear() > 2200) throw new DateTimeException("date");
            return date;
        } catch (DateTimeException ex) {
            throw ApiException.badRequest("INVALID_PERIOD", "날짜를 확인하세요.");
        }
    }

    private static final class Totals {
        private final String name;
        private long people;
        private long dropped;
        private long findings;
        private long activities;
        private long minutes;

        Totals(String name) {
            this.name = name;
        }

        DistrictTotals view() {
            return new DistrictTotals(name, people, dropped, findings, activities, minutes);
        }
    }
}
