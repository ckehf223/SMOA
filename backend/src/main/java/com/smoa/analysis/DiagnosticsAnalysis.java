package com.smoa.analysis;

import java.time.DayOfWeek;
import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.temporal.ChronoUnit;
import java.time.temporal.TemporalAdjusters;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.IntStream;

import com.smoa.analysis.AnalysisData.Filter;
import com.smoa.analysis.AnalysisData.Finding;
import com.smoa.analysis.AnalysisData.Rows;
import com.smoa.analysis.FindingAnalysis.Span;
import com.smoa.permission.DistrictKey;

final class DiagnosticsAnalysis {
    record Period(LocalDate from, LocalDate to) {}
    record Quality(long findingsWithoutTime, long findingsWithoutPlace, long activitiesWithoutTime,
            long activitiesWithoutPlace, long activitiesWithoutWorker) {}
    record Cohort(String label, int days, long started, long reached, long completed, long observing, Double rate) {}
    record PeriodStats(Period period, long roadFindings, long roadActivities, Quality quality, List<Cohort> cohorts) {}
    record Location(String district, String place, Integer hour, long records, long workers, long minutes, long findings) {}
    record Summary(LocalDate asOf, List<PeriodStats> periods, List<Location> locations) {}

    private record LocationKey(DistrictKey district, String place, Integer hour) {}

    private static final class LocationStats {
        long records;
        long minutes;
        long findings;
        final Set<List<String>> workers = new HashSet<>();
    }

    private DiagnosticsAnalysis() {}

    static List<Period> periods(LocalDate anchor, LocalDate today, boolean month) {
        Period current = calendar(anchor, month, 0);
        long elapsed = current.to().isAfter(today) ? ChronoUnit.DAYS.between(current.from(), today) : -1;
        return IntStream.range(0, 3).mapToObj(offset -> {
            Period full = calendar(anchor, month, offset);
            LocalDate clipped = elapsed == -1 ? full.to() : full.from().plusDays(elapsed);
            return new Period(full.from(), clipped.isBefore(full.to()) ? clipped : full.to());
        }).toList();
    }

    private static Period calendar(LocalDate anchor, boolean month, int offset) {
        if (month) {
            LocalDate start = anchor.withDayOfMonth(1).minusMonths(offset);
            return new Period(start, start.plusMonths(1).minusDays(1));
        }
        LocalDate start = anchor.with(TemporalAdjusters.previousOrSame(DayOfWeek.SUNDAY)).minusWeeks(offset);
        return new Period(start, start.plusDays(6));
    }

    static Summary summarize(List<Period> periods, Rows rows, Filter filter, LocalDate today, Map<DistrictKey, String> districts) {
        var summaries = periods.stream().map(period -> {
            var range = new Filter(period.from(), period.to(), filter.regionCode(), filter.districtCode(), false);
            var roadFindings = rows.findings().stream().filter(row -> road(row) && range.includes(row.date())).toList();
            var activities = rows.activities().stream().filter(row -> range.includes(row.date())).toList();
            var quality = new Quality(roadFindings.stream().filter(row -> row.time() == null).count(),
                    roadFindings.stream().filter(row -> FindingAnalysis.clean(row.place()) == null).count(),
                    activities.stream().filter(row -> row.start() == null || row.end() == null || row.start().equals(row.end())).count(),
                    activities.stream().filter(row -> FindingAnalysis.clean(row.place()) == null).count(),
                    activities.stream().filter(row -> worker(row).isEmpty()).count());
            return new PeriodStats(period, roadFindings.size(), activities.size(), quality,
                    List.of(cohort("찾B → 만픽", 7, rows.findings(), range, today, Finding::date, Finding::manpikDate),
                            cohort("만픽 → 찾A", 14, rows.findings(), range, today, Finding::manpikDate, Finding::findADate)));
        }).toList();
        var range = new Filter(periods.getFirst().from(), periods.getFirst().to(), filter.regionCode(), filter.districtCode(), false);
        return new Summary(today, summaries, places(rows, range, districts));
    }

    private static Cohort cohort(String label, int days, List<Finding> rows, Filter range, LocalDate today,
            Function<Finding, LocalDate> source, Function<Finding, LocalDate> target) {
        long reached = 0, completed = 0, observing = 0;
        for (Finding row : rows) {
            LocalDate start = source.apply(row);
            if (!range.includes(start)) continue;
            LocalDate deadline = start.plusDays(days);
            if (deadline.isAfter(today)) { observing++; continue; }
            completed++;
            LocalDate finish = target.apply(row);
            if (finish != null && !finish.isBefore(start) && !finish.isAfter(deadline)) reached++;
        }
        return new Cohort(label, days, completed + observing, reached, completed, observing,
                completed == 0 ? null : (double) reached / completed);
    }

    private static List<Location> places(Rows rows, Filter filter, Map<DistrictKey, String> districts) {
        record WorkerPlace(DistrictKey district, String place, List<String> worker) {}
        var places = new HashMap<LocationKey, LocationStats>();
        var workers = new HashMap<WorkerPlace, List<Span>>();
        for (var activity : rows.activities()) {
            String place = FindingAnalysis.clean(activity.place());
            var worker = worker(activity);
            Span span = FindingAnalysis.clipped(activity, filter);
            if (span == null) {
                if (filter.includes(activity.date())) {
                    var group = places.computeIfAbsent(new LocationKey(activity.district(), place, null), key -> new LocationStats());
                    group.records++;
                    if (!worker.isEmpty()) group.workers.add(worker);
                }
                continue;
            }
            split(span, (hour, portion) -> {
                var group = places.computeIfAbsent(new LocationKey(activity.district(), place, hour), key -> new LocationStats());
                group.records++;
                if (!worker.isEmpty()) group.workers.add(worker);
            });
            if (!worker.isEmpty()) workers.computeIfAbsent(new WorkerPlace(activity.district(), place, worker), id -> new ArrayList<>()).add(span);
        }
        workers.forEach((key, intervals) -> FindingAnalysis.mergeSpans(intervals).forEach(span -> split(span, (hour, portion) ->
                places.get(new LocationKey(key.district(), key.place(), hour)).minutes += portion)));
        for (var finding : rows.findings()) {
            if (!road(finding) || !filter.includes(finding.date())) continue;
            var key = new LocationKey(finding.district(), FindingAnalysis.clean(finding.place()),
                    finding.time() == null ? null : finding.time().getHour());
            places.computeIfAbsent(key, ignored -> new LocationStats()).findings++;
        }
        return places.entrySet().stream().map(entry -> {
            var key = entry.getKey();
            var value = entry.getValue();
            return new Location(FindingAnalysis.districtName(key.district(), districts), key.place() == null ? "장소 미입력" : key.place(),
                    key.hour(), value.records, value.workers.size(), value.minutes, value.findings);
        }).sorted(Comparator.comparing(Location::district).thenComparing(Location::place)
                .thenComparing(Location::hour, Comparator.nullsLast(Comparator.naturalOrder()))).toList();
    }

    private static List<String> worker(AnalysisData.Activity row) {
        String id = FindingAnalysis.clean(row.workerId());
        if (id != null) return List.of("id", id);
        String code = FindingAnalysis.clean(row.workerCode());
        if (code != null) return List.of("code", code);
        String name = FindingAnalysis.clean(row.workerName());
        return name == null ? List.of() : List.of("name", name);
    }

    private static boolean road(Finding row) {
        return "노방".equals(row.classification());
    }

    private static void split(Span span, java.util.function.BiConsumer<Integer, Long> visit) {
        for (LocalDateTime at = span.start(); at.isBefore(span.end());) {
            LocalDateTime endHour = at.truncatedTo(ChronoUnit.HOURS).plusHours(1);
            LocalDateTime next = endHour.isBefore(span.end()) ? endHour : span.end();
            visit.accept(at.getHour(), Duration.between(at, next).toMinutes());
            at = next;
        }
    }
}
