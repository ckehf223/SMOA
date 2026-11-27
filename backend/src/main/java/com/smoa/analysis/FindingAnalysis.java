package com.smoa.analysis;

import java.text.Collator;
import java.text.Normalizer;
import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.regex.Pattern;
import java.util.stream.IntStream;

import com.smoa.analysis.AnalysisData.Activity;
import com.smoa.analysis.AnalysisData.Filter;
import com.smoa.analysis.AnalysisData.Rows;
import com.smoa.permission.DistrictKey;

final class FindingAnalysis {
    private static final Pattern MARKER = Pattern.compile("(?:^|[\\s()\\[\\]{}·,;:：/])주관자(?=$|[\\s()\\[\\]{}·,;:：/])");
    private static final Pattern EXCLUDED = Pattern.compile("비주관자|주관자\\s*(?:아님|없음|아니)");
    static final String UNLINKED = "__unlinked__";
    static final String UNCLASSIFIED = "__unclassified__";

    record Day(LocalDate date, long total, long missingTime) {}
    record Hour(int hour, long total, long linked) {}
    record Gap(long missingTime, long missingDistrict, long noSession, long ambiguous) {}
    record Session(String district, LocalDateTime start, LocalDateTime end, long minutes, long linked) {}
    record Leader(String name, String jobCode, List<String> districts, int records, int missingTime, long minutes,
            long linked, long uncertainSessions, List<Integer> peakHours, Double efficiency, List<Session> sessions) {}
    record Summary(Filter filters, long total, long linked, long selectedLinked, Gap gaps, List<Day> days,
            List<Hour> hours, List<Leader> leaders, List<String> jobCodes) {}

    private record Identity(String origin, String key, DistrictKey district) {}
    private record LeaderDistrict(Identity leader, DistrictKey district) {}
    private record DayDistrict(LocalDate date, DistrictKey district) {}
    record Span(LocalDateTime start, LocalDateTime end) {
        long minutes() {
            return Duration.between(start, end).toMinutes();
        }

        boolean matches(LocalDateTime at) {
            if (at.equals(at.truncatedTo(ChronoUnit.HOURS))) {
                return !at.isBefore(start.truncatedTo(ChronoUnit.HOURS)) && !at.isAfter(end.truncatedTo(ChronoUnit.HOURS));
            }
            return !at.isBefore(start) && at.isBefore(end);
        }
    }

    private static final class LinkedSession {
        final LeaderDistrict key;
        final Span span;
        long linked;

        LinkedSession(LeaderDistrict key, Span span) {
            this.key = key;
            this.span = span;
        }
    }

    private static final class Accumulator {
        final String name;
        final String job;
        final List<LinkedSession> sessions = new ArrayList<>();
        final List<DistrictKey> districts = new ArrayList<>();
        int records;
        int missingTime;
        long linked;
        long uncertain;

        Accumulator(String name, String job) {
            this.name = name == null ? "이름 미입력" : name;
            this.job = job;
        }
    }

    private FindingAnalysis() {}

    static Summary summarize(Filter filter, Rows rows, Map<DistrictKey, String> names, String jobFilter) {
        Map<Identity, Accumulator> leaders = new LinkedHashMap<>();
        Map<LeaderDistrict, List<Span>> spans = new LinkedHashMap<>();
        for (Activity activity : rows.activities()) {
            if (activity.memo() == null || !MARKER.matcher(activity.memo()).find() || EXCLUDED.matcher(activity.memo()).find()) continue;
            Span span = clipped(activity, filter);
            if (span == null && !filter.includes(activity.date())) continue;
            Identity identity = identity(activity);
            Accumulator leader = leaders.computeIfAbsent(identity, key -> new Accumulator(clean(activity.workerName()),
                    clean(activity.jobCode()) != null ? activity.jobCode() : clean(activity.workerId()) != null ? UNCLASSIFIED : UNLINKED));
            leader.records++;
            if (!leader.districts.contains(activity.district())) leader.districts.add(activity.district());
            if (span == null) {
                if (activity.start() == null || activity.end() == null || activity.start().equals(activity.end())) leader.missingTime++;
            } else {
                spans.computeIfAbsent(new LeaderDistrict(identity, activity.district()), key -> new ArrayList<>()).add(span);
            }
        }

        Map<DayDistrict, List<LinkedSession>> byDay = new HashMap<>();
        spans.forEach((key, intervals) -> mergeSpans(intervals).forEach(span -> {
            var session = new LinkedSession(key, span);
            leaders.get(key.leader()).sessions.add(session);
            if (key.district() != null) {
                for (LocalDate date = span.start().toLocalDate(); !date.isAfter(span.end().toLocalDate()); date = date.plusDays(1)) {
                    byDay.computeIfAbsent(new DayDistrict(date, key.district()), ignored -> new ArrayList<>()).add(session);
                }
            }
        }));

        long total = 0, linked = 0, missingTime = 0, missingDistrict = 0, noSession = 0, ambiguous = 0;
        var days = new TreeMap<LocalDate, long[]>();
        if (filter.from() != null && filter.to() != null) {
            filter.from().datesUntil(filter.to().plusDays(1)).forEach(day -> days.put(day, new long[2]));
        }
        long[] hourly = new long[24], linkedHourly = new long[24];
        for (var finding : rows.findings()) {
            if (!filter.includes(finding.date())) continue;
            total++;
            long[] day = days.computeIfAbsent(finding.date(), ignored -> new long[2]);
            day[0]++;
            if (finding.time() == null) { missingTime++; day[1]++; continue; }
            int hour = finding.time().getHour();
            hourly[hour]++;
            if (finding.district() == null) { missingDistrict++; continue; }
            LocalDateTime at = finding.date().atTime(finding.time());
            var candidates = byDay.getOrDefault(new DayDistrict(finding.date(), finding.district()), List.of()).stream()
                    .filter(session -> session.span.matches(at)).toList();
            if (candidates.isEmpty()) { noSession++; continue; }
            Identity owner = candidates.getFirst().key.leader();
            if (candidates.stream().anyMatch(session -> !session.key.leader().equals(owner))) { ambiguous++; continue; }
            linked++;
            var leader = leaders.get(owner);
            leader.linked++;
            if (jobFilter == null || jobFilter.equals(leader.job)) linkedHourly[hour]++;
            if (candidates.size() == 1) candidates.getFirst().linked++;
            else leader.uncertain++;
        }

        var collator = Collator.getInstance(Locale.KOREAN);
        var summaries = leaders.values().stream().filter(leader -> jobFilter == null || jobFilter.equals(leader.job))
                .map(leader -> row(leader, names)).sorted(Comparator.comparingLong(Leader::linked).reversed()
                        .thenComparing(Leader::name, collator)).toList();
        long selected = summaries.stream().mapToLong(Leader::linked).sum();
        return new Summary(filter, total, linked, selected, new Gap(missingTime, missingDistrict, noSession, ambiguous),
                days.entrySet().stream().map(e -> new Day(e.getKey(), e.getValue()[0], e.getValue()[1])).toList(),
                IntStream.range(0, 24).mapToObj(hour -> new Hour(hour, hourly[hour], linkedHourly[hour])).toList(), summaries,
                leaders.values().stream().map(leader -> leader.job).distinct().sorted().toList());
    }

    private static Leader row(Accumulator leader, Map<DistrictKey, String> names) {
        long[] hourly = new long[24];
        List<Span> union = mergeSpans(leader.sessions.stream().map(session -> session.span).toList());
        for (Span span : union) {
            for (LocalDateTime at = span.start(); at.isBefore(span.end());) {
                LocalDateTime next = at.truncatedTo(ChronoUnit.HOURS).plusHours(1);
                if (next.isAfter(span.end())) next = span.end();
                hourly[at.getHour()] += Duration.between(at, next).toMinutes();
                at = next;
            }
        }
        long minutes = union.stream().mapToLong(Span::minutes).sum();
        long peak = java.util.Arrays.stream(hourly).max().orElse(0);
        var sessions = leader.sessions.stream().sorted(Comparator.comparing(session -> session.span.start()))
                .map(session -> new Session(districtName(session.key.district(), names), session.span.start(),
                        session.span.end(), session.span.minutes(), session.linked)).toList();
        return new Leader(leader.name, leader.job, leader.districts.stream().map(district -> districtName(district, names)).toList(),
                leader.records, leader.missingTime, minutes, leader.linked, leader.uncertain,
                IntStream.range(0, 24).filter(hour -> peak > 0 && hourly[hour] == peak).boxed().toList(),
                minutes == 0 ? null : 60.0 * leader.linked / minutes, sessions);
    }

    static String districtName(DistrictKey key, Map<DistrictKey, String> names) {
        return key == null ? "구역 미입력" : names.getOrDefault(key, key.districtCode());
    }

    static String clean(String value) {
        return value == null || value.isBlank() ? null : Normalizer.normalize(value.strip(), Normalizer.Form.NFC);
    }

    private static Identity identity(Activity row) {
        if (clean(row.workerId()) != null) return new Identity("id", row.workerId(), null);
        if (clean(row.workerCode()) != null) return new Identity("code", row.workerCode(), null);
        return new Identity("name", Objects.toString(clean(row.workerName()), ""), row.district());
    }

    static Span clipped(Activity row, Filter filter) {
        if (row.start() == null || row.end() == null || row.start().equals(row.end())) return null;
        LocalDateTime from = row.date().atTime(row.start());
        LocalDateTime to = row.date().atTime(row.end());
        if (to.isBefore(from)) to = to.plusDays(1);
        if (filter.from() != null && from.isBefore(filter.from().atStartOfDay())) from = filter.from().atStartOfDay();
        if (filter.to() != null && to.isAfter(filter.to().plusDays(1).atStartOfDay())) to = filter.to().plusDays(1).atStartOfDay();
        return to.isAfter(from) ? new Span(from, to) : null;
    }

    static List<Span> mergeSpans(List<Span> rows) {
        var merged = new ArrayList<Span>();
        for (Span next : rows.stream().sorted(Comparator.comparing(Span::start).thenComparing(Span::end)).toList()) {
            Span last = merged.isEmpty() ? null : merged.getLast();
            if (last == null || next.start().isAfter(last.end())) merged.add(next);
            else if (next.end().isAfter(last.end())) merged.set(merged.size() - 1, new Span(last.start(), next.end()));
        }
        return merged;
    }
}
