package com.smoa.analytics;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import com.smoa.access.AccessGrant;
import com.smoa.common.ApiException;
import com.smoa.config.LibraryContext;
import com.smoa.module.mapper.AnalyticsMapper;
import com.smoa.permission.DistrictKey;
import com.smoa.permission.ScopeType;
import com.smoa.scope.ScopeEnforcer;

@Service
@Profile({"local", "prod"})
public class PerformanceService {

    public record Filter(String from, String to, String regionCode, String districtCode, String className,
            String classification, String mode) {}

    public record Metric(String key, String label) {}
    public record Line(String district, String group, Map<String, Long> values) {}
    public record Overview(Filter period, List<Metric> metrics, List<Line> rows, Map<String, Long> total) {}
    private record Group(DistrictKey key, String code) {}

    private static final List<Metric> STAGES = List.of(
            new Metric("findings", "찾B"), new Metric("manpik", "만픽"), new Metric("findA", "찾A"),
            new Metric("habB", "합B"), new Metric("habA", "합A"), new Metric("youngTta", "영따"),
            new Metric("bokshin", "복신"), new Metric("cardReceived", "신카접수"),
            new Metric("centerRegistered", "센터등록"));
    private static final List<Metric> ACTIVITY = List.of(new Metric("activities", "활동 건수"),
            new Metric("minutes", "활동 시간(분)"));
    private static final List<Metric> ALL_METRICS = java.util.stream.Stream.concat(STAGES.stream(), ACTIVITY.stream()).toList();

    private final AnalyticsService analytics;
    private final AnalyticsMapper mapper;
    private final LibraryContext library;
    private final ScopeEnforcer enforcer;

    public PerformanceService(AnalyticsService analytics, AnalyticsMapper mapper, LibraryContext library, ScopeEnforcer enforcer) {
        this.analytics = analytics;
        this.mapper = mapper;
        this.library = library;
        this.enforcer = enforcer;
    }

    public Overview overview(AccessGrant grant, String program, String from, String to, String region, String district,
            String className, String classification) {
        var query = AnalyticsService.period(from, to, region, district);
        String mode = switch (program) {
            case "memberData" -> "MEMBER";
            case "classData" -> "CLASS";
            case "stagePerformance" -> "STAGE";
            default -> throw ApiException.notFound("통계 메뉴를 찾을 수 없습니다.");
        };
        Filter filter = new Filter(query.from(), query.to(), query.regionCode(), query.districtCode(),
                optional(className, 60), optional(classification, 20), mode);
        boolean stageView = "STAGE".equals(mode);
        List<Metric> metrics = stageView ? STAGES : ALL_METRICS;
        var scope = enforcer.effectiveScope(grant);
        Map<String, Long> total = zero(metrics);
        if (scope.isEmptyAssignment()) return new Overview(filter, metrics, List.of(), total);
        List<DistrictKey> allowed = List.copyOf(scope.districts());
        Map<DistrictKey, String> names = analytics.districtNames(scope);
        boolean unassigned = scope.type() == ScopeType.ALL;
        List<Map<String, Object>> findings = mapper.selectPerformancePeople(library.id(), filter, allowed, unassigned);
        List<Map<String, Object>> activities = stageView ? List.of()
                : mapper.selectPerformanceActivity(library.id(), filter, allowed, unassigned);
        Map<Group, String> labels = new LinkedHashMap<>();
        Map<Group, Map<String, Long>> rows = new LinkedHashMap<>();
        for (Map<String, Object> row : findings) accumulate(metrics, row, total, labels, rows);
        for (Map<String, Object> row : activities) accumulate(metrics, row, total, labels, rows);
        List<Line> lines = new ArrayList<>();
        rows.forEach((group, values) -> {
            String districtName = names.getOrDefault(group.key(), "구역 미지정");
            String label = switch (mode) {
                case "MEMBER" -> labels.getOrDefault(group, "활동자·인도자 미입력");
                case "CLASS" -> group.code().isEmpty() ? "반 미지정" : group.code();
                default -> "";
            };
            lines.add(new Line(districtName, label, values));
        });
        Comparator<String> order = java.text.Collator.getInstance(Locale.KOREAN)::compare;
        lines.sort(Comparator.comparing(Line::district, order).thenComparing(Line::group, order));
        return new Overview(filter, metrics, List.copyOf(lines), total);
    }

    private static void accumulate(List<Metric> metrics, Map<String, Object> row, Map<String, Long> total,
            Map<Group, String> labels, Map<Group, Map<String, Long>> rows) {
        String region = (String) row.get("regionCode");
        String district = (String) row.get("districtCode");
        DistrictKey key = DistrictKey.valid(region, district) ? new DistrictKey(region, district) : null;
        Group group = new Group(key, (String) row.get("groupKey"));
        String name = (String) row.get("itemName");
        if (name != null && !name.isBlank()) labels.putIfAbsent(group, name);
        Map<String, Long> values = rows.computeIfAbsent(group, ignored -> zero(metrics));
        for (Metric metric : metrics) {
            Object value = row.get(metric.key());
            if (value instanceof Number number) {
                values.merge(metric.key(), number.longValue(), Long::sum);
                total.merge(metric.key(), number.longValue(), Long::sum);
            }
        }
    }

    private static Map<String, Long> zero(List<Metric> metrics) {
        Map<String, Long> values = new LinkedHashMap<>();
        for (Metric metric : metrics) values.put(metric.key(), 0L);
        return values;
    }

    private static String optional(String value, int limit) {
        if (value == null || value.isBlank()) return null;
        if (value.length() > limit) throw ApiException.badRequest("INVALID_FILTER", "조회 조건을 확인하세요.");
        return value.strip();
    }
}
