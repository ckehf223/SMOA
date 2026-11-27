package com.smoa.organization;

import static com.smoa.organization.BusinessService.date;
import static com.smoa.organization.BusinessService.key;
import static com.smoa.organization.BusinessService.normalize;
import static com.smoa.organization.BusinessService.text;

import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.smoa.access.AccessGrant;
import com.smoa.common.ApiException;
import com.smoa.organization.BusinessService.Filters;
import com.smoa.organization.persistence.BusinessMapper;
import com.smoa.permission.DistrictKey;
import com.smoa.scope.ScopeEnforcer;

@Service
@Profile({"local", "prod"})
@Transactional(readOnly = true)
public class RegionDataService {
    private static final String STREET = "노방";
    private static final String SOCIALING = "소셜링";
    private static final String UNCLASSIFIED = "__unclassified__";
    private final BusinessService shared;
    private final BusinessMapper mapper;
    private final ScopeEnforcer enforcer;

    public RegionDataService(BusinessService shared, BusinessMapper mapper, ScopeEnforcer enforcer) {
        this.shared = shared;
        this.mapper = mapper;
        this.enforcer = enforcer;
    }

    public record Query(String from, String to, String regionCode, String districtCode, String classification2) {
    }

    public record DistrictRow(String regionCode, String districtCode, String name, int members, int street,
            int socialing, int combined, int streetOnly, int socialingOnly, int both, int neither, long minutes,
            int matched, int findings, int previous, int change) {
    }

    public record TimeRow(String time, int findings, int streetFindings, int matched, long minutes) {
    }

    public record DistrictHours(String name, List<TimeRow> hours) {
    }

    public record Result(LocalDate from, LocalDate to, LocalDate previousFrom, LocalDate previousTo, String classification2,
            DistrictRow total, List<DistrictRow> items, List<TimeRow> days, List<TimeRow> hours,
            List<DistrictHours> districtHours, List<String> classifications, List<Map<String, Object>> districts) {
    }

    private record Credited(DistrictKey district, String member) {
    }

    private record Span(LocalDateTime from, LocalDateTime to) {
    }

    public Result overview(AccessGrant grant, Query request) {
        LocalDate to = date(request.to());
        LocalDate from = date(request.from());
        if (to == null) {
            to = LocalDate.now(BusinessService.SEOUL);
        }
        if (from == null) {
            from = to.withDayOfMonth(1);
        }
        long period = java.time.temporal.ChronoUnit.DAYS.between(from, to) + 1;
        if (period < 1 || period > 366 || from.minusDays(period).getYear() < 1000) {
            throw ApiException.badRequest("INVALID_DATE_RANGE", "조회 기간을 1년 이내로 지정해 주세요.");
        }
        String selectedClassification = request.classification2() == null ? STREET
                : "all".equals(request.classification2()) ? null : BusinessService.optional(request.classification2(), 60);
        LocalDate previousFrom = from.minusDays(period);
        LocalDate previousTo = from.minusDays(1);
        var bounded = shared.query(grant, filter(request.regionCode(), request.districtCode(), from, to));
        DistrictKey selectedDistrict = district(bounded);
        var full = shared.query(grant, filter(null, null, null, null));
        var districts = shared.districts(grant);
        var isVisible = enforcer.visibility(grant);

        var tally = new LinkedHashMap<DistrictKey, Tally>();
        for (var district : districts) {
            DistrictKey group = key(text(district, "regionCode"), text(district, "districtCode"));
            if (selectedDistrict == null || selectedDistrict.equals(group)) {
                tally.put(group, new Tally(text(district, "regionName") + " / " + text(district, "districtName")));
            }
        }
        var total = new Tally("조회 합계");
        var rosterByName = new HashMap<Credited, List<String>>();
        for (var row : mapper.selectOrganizationMembers(bounded)) {
            var district = district(row);
            var id = text(row, "id");
            rosterByName.computeIfAbsent(new Credited(district, normalize(text(row, "name"))), unused -> new ArrayList<>()).add(id);
            if (BusinessService.activeMember(row)) {
                group(tally, district).members.add(id);
                total.members.add(id);
            }
        }

        var days = new LinkedHashMap<LocalDate, Time>();
        from.datesUntil(to.plusDays(1)).forEach(day -> days.put(day, new Time(day.toString())));
        var low = from.atStartOfDay();
        var high = to.plusDays(1).atStartOfDay();
        var spans = new HashMap<Credited, List<Span>>();
        for (var row : mapper.selectDistrictActivities(bounded)) {
            var district = district(row);
            String classification = text(row, "classification2");
            if (classification.isEmpty()) {
                classification = STREET;
            }
            String member = resolveMember(row, district, rosterByName);
            LocalDate day = date(text(row, "date"));
            Span span = clipped(row, day, low, high);
            if (member != null && (span != null || days.containsKey(day))) {
                var count = group(tally, district);
                if (count.members.contains(member)) {
                    count.mark(member, classification);
                    total.mark(member, classification);
                }
            }
            if (member != null && span != null && STREET.equals(classification)) {
                spans.computeIfAbsent(new Credited(district, member), unused -> new ArrayList<>()).add(span);
            }
        }
        var totalSpans = new HashMap<String, List<Span>>();
        for (var entry : spans.entrySet()) {
            List<Span> merged = merge(entry.getValue());
            entry.setValue(merged);
            group(tally, entry.getKey().district()).addTime(merged, Map.of());
            totalSpans.computeIfAbsent(entry.getKey().member(), ignored -> new ArrayList<>()).addAll(merged);
        }
        totalSpans.values().forEach(workerSpans -> total.addTime(merge(workerSpans), days));

        var classifications = new java.util.TreeSet<String>();
        for (var row : mapper.selectFindingAttainments(full)) {
            var district = district(row);
            if (!isVisible.test(district) || (selectedDistrict != null && !selectedDistrict.equals(district))) {
                continue;
            }
            var day = date(text(row, "date"));
            if (day == null) {
                continue;
            }
            String classification = text(row, "classification2");
            if (!classification.isEmpty()) {
                classifications.add(classification);
            }
            boolean included = selectedClassification == null || (UNCLASSIFIED.equals(selectedClassification)
                    ? classification.isEmpty() : selectedClassification.equals(classification));
            if (included && !day.isBefore(previousFrom) && !day.isAfter(previousTo)) {
                group(tally, district).previous++;
                total.previous++;
            }
            if (!days.containsKey(day)) {
                continue;
            }
            var daily = days.get(day);
            LocalTime time = time(text(row, "foundTime"));
            Tally group = group(tally, district);
            if (included) {
                group.findings++;
                total.findings++;
                daily.findings++;
                if (time != null) {
                    total.hours.get(time.getHour()).findings++;
                    group.hours.get(time.getHour()).findings++;
                }
            }
            if (STREET.equals(classification)) {
                daily.streetFindings++;
                if (time != null) {
                    Time hourly = total.hours.get(time.getHour());
                    Time districtHour = group.hours.get(time.getHour());
                    hourly.streetFindings++;
                    districtHour.streetFindings++;
                    String member = resolveMember(row, district, rosterByName);
                    LocalDateTime at = day.atTime(time);
                    if (member != null && district != null && spans.getOrDefault(new Credited(district, member), List.of())
                            .stream().anyMatch(span -> matches(span, at))) {
                        group.matched++;
                        total.matched++;
                        daily.matched++;
                        hourly.matched++;
                        districtHour.matched++;
                    }
                }
            }
        }
        return new Result(from, to, previousFrom, previousTo, selectedClassification,
                total.row(null), tally.entrySet().stream().map(e -> e.getValue().row(e.getKey())).toList(),
                days.values().stream().map(Time::row).toList(), total.hours.stream().map(Time::row).toList(),
                tally.values().stream().map(t -> new DistrictHours(t.name, t.hours.stream().map(Time::row).toList())).toList(),
                List.copyOf(classifications), districts);
    }

    private static List<Span> merge(List<Span> spans) {
        spans.sort(Comparator.comparing(Span::from).thenComparing(Span::to));
        var merged = new ArrayList<Span>();
        for (var span : spans) {
            if (merged.isEmpty() || span.from().isAfter(merged.getLast().to())) {
                merged.add(span);
            } else if (span.to().isAfter(merged.getLast().to())) {
                merged.set(merged.size() - 1, new Span(merged.getLast().from(), span.to()));
            }
        }
        return merged;
    }

    private static Span clipped(Map<String, Object> row, LocalDate day, LocalDateTime low, LocalDateTime high) {
        LocalTime start = time(text(row, "start"));
        LocalTime end = time(text(row, "endTime"));
        if (day == null || start == null || end == null || start.equals(end)) {
            return null;
        }
        LocalDateTime left = day.atTime(start);
        LocalDateTime right = (end.isBefore(start) ? day.plusDays(1) : day).atTime(end);
        left = left.isBefore(low) ? low : left;
        right = right.isAfter(high) ? high : right;
        return left.isBefore(right) ? new Span(left, right) : null;
    }

    private static boolean matches(Span span, LocalDateTime at) {
        if (at.getMinute() == 0) {
            return !at.isBefore(span.from().withMinute(0)) && !at.isAfter(span.to().withMinute(0));
        }
        return !at.isBefore(span.from()) && at.isBefore(span.to());
    }

    private static String resolveMember(Map<String, Object> row, DistrictKey district, Map<Credited, List<String>> roster) {
        String id = text(row, "memberId");
        if (!id.isEmpty()) {
            return id;
        }
        String name = normalize(text(row, "workerName"));
        var names = roster.getOrDefault(new Credited(district, name), List.of());
        if (names.size() == 1) {
            return names.getFirst();
        }
        return name.isEmpty() || names.size() > 1 ? null : "external:" + district + ":" + name;
    }

    private static DistrictKey district(Map<String, Object> row) {
        return key(text(row, "regionCode"), text(row, "districtCode"));
    }

    private static LocalTime time(String value) {
        if (value.isEmpty()) {
            return null;
        }
        try {
            return LocalTime.parse(value);
        } catch (java.time.format.DateTimeParseException invalidTime) {
            return null;
        }
    }

    private static Tally group(Map<DistrictKey, Tally> groups, DistrictKey key) {
        return groups.computeIfAbsent(key, unused -> new Tally(key == null ? "구역 미입력" : key.districtCode()));
    }

    private static Filters filter(String region, String district, LocalDate from, LocalDate to) {
        return new Filters(region, district, from == null ? null : from.toString(), to == null ? null : to.toString(),
                null, null, null, null, null, null, null, null, null, null);
    }

    private static final class Tally {
        private final String name;
        private final Set<String> members = new HashSet<>();
        private final Set<String> street = new HashSet<>();
        private final Set<String> socialing = new HashSet<>();
        private final List<Time> hours = new ArrayList<>(24);
        private long minutes;
        private int matched;
        private int findings;
        private int previous;

        private Tally(String name) {
            this.name = name;
            for (int hour = 0; hour < 24; hour++) {
                hours.add(new Time(String.format(java.util.Locale.ROOT, "%02d시", hour)));
            }
        }

        private void mark(String member, String classification) {
            if (STREET.equals(classification)) {
                street.add(member);
            } else if (SOCIALING.equals(classification)) {
                socialing.add(member);
            }
        }

        private void addTime(List<Span> spans, Map<LocalDate, Time> days) {
            for (Span span : spans) {
                for (LocalDateTime start = span.from(); start.isBefore(span.to());) {
                    LocalDateTime hourEnd = start.withMinute(0).plusHours(1);
                    LocalDateTime end = hourEnd.isAfter(span.to()) ? span.to() : hourEnd;
                    long elapsed = Duration.between(start, end).toMinutes();
                    minutes += elapsed;
                    hours.get(start.getHour()).minutes += elapsed;
                    Time day = days.get(start.toLocalDate());
                    if (day != null) {
                        day.minutes += elapsed;
                    }
                    start = end;
                }
            }
        }

        private DistrictRow row(DistrictKey key) {
            var combined = new HashSet<>(street);
            combined.addAll(socialing);
            int both = street.size() + socialing.size() - combined.size();
            return new DistrictRow(key == null ? null : key.regionCode(), key == null ? null : key.districtCode(),
                    name, members.size(), street.size(), socialing.size(), combined.size(), street.size() - both,
                    socialing.size() - both, both, members.size() - combined.size(), minutes, matched, findings, previous,
                    findings - previous);
        }
    }

    private static final class Time {
        private final String label;
        private int findings;
        private int streetFindings;
        private int matched;
        private long minutes;

        private Time(String label) {
            this.label = label;
        }

        private TimeRow row() {
            return new TimeRow(label, findings, streetFindings, matched, minutes);
        }
    }
}
