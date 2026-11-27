package com.smoa.organization;

import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.function.Predicate;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.smoa.access.AccessGrant;
import com.smoa.common.ApiException;
import com.smoa.config.LibraryContext;
import com.smoa.organization.persistence.BusinessMapper;
import com.smoa.permission.DistrictKey;
import com.smoa.permission.ScopeType;
import com.smoa.reference.ReferenceRepository;
import com.smoa.reference.Region;
import com.smoa.scope.ScopeEnforcer;

/** Reads organizational records from the configured library with the requesting account's scope. */
@Service
@Profile({"local", "prod"})
@Transactional(readOnly = true)
public class BusinessService {
    static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
    private static final Map<String, String> MILESTONES = Map.ofEntries(
            Map.entry("만픽", "manpikDate"), Map.entry("찾a", "findADate"),
            Map.entry("합b", "habBDate"), Map.entry("합a(육따)", "habADate"),
            Map.entry("합a", "habADate"), Map.entry("육따", "habADate"),
            Map.entry("영따", "youngTtaDate"), Map.entry("복음방", "bokshinDate"),
            Map.entry("복신", "bokshinDate"), Map.entry("복a", "bokshinDate"),
            Map.entry("복b", "bokshinDate"), Map.entry("신카접수", "cardReceivedDate"),
            Map.entry("신가접수", "cardReceivedDate"), Map.entry("센터등록", "centerRegisteredDate"));
    private static final List<String> ACTIVITY_LABELS = List.of("미기록", "적극적 활동자", "전도비 후원자", "소극적 활동자", "비활동자");

    private final BusinessMapper mapper;
    private final LibraryContext library;
    private final ScopeEnforcer enforcer;
    private final ReferenceRepository reference;

    public BusinessService(BusinessMapper mapper, LibraryContext library, ScopeEnforcer enforcer,
            ReferenceRepository reference) {
        this.mapper = mapper;
        this.library = library;
        this.enforcer = enforcer;
        this.reference = reference;
    }

    public record Filters(String regionCode, String districtCode, String from, String to, String className,
            String stage, String mode, String month, String date, Integer status, String programId, String q,
            String use, String socialStatus) {
    }

    public Map<String, Object> organization(AccessGrant grant, Filters filters) {
        List<Map<String, Object>> districts = districts(grant);
        var regionCodes = new LinkedHashSet<>();
        districts.forEach(row -> regionCodes.add(row.get("regionCode")));
        boolean all = grant.scope().type() == ScopeType.ALL;
        List<Region> regions = reference.regions().stream()
                .filter(region -> all || regionCodes.contains(region.regionCode())).toList();
        String search = Objects.toString(optional(filters.q(), 120), "").toLowerCase(Locale.ROOT);
        String use = optional(filters.use(), 1);
        var members = mapper.selectOrganizationMembers(query(grant, filters)).stream()
                .filter(row -> use == null || use.equals(text(row, "useInd")))
                .filter(row -> search.isEmpty() || List.of("name", "code", "className", "districtName").stream()
                        .anyMatch(field -> text(row, field).toLowerCase(Locale.ROOT).contains(search)))
                .toList();
        return Map.of("regions", regions, "districts", districts, "members", members);
    }

    public Map<String, Object> codes() {
        var query = Map.<String, Object>of("libraryId", library.id());
        return Map.of("groups", mapper.selectCodeGroups(query), "items", mapper.selectCodes(query));
    }

    public Map<String, Object> goals(AccessGrant grant, Filters filters) {
        var query = query(grant, filters);
        List<Map<String, Object>> stages = mapper.selectCodes(query).stream()
                .filter(item -> text(item, "groupCode").equals("STAGE")).toList();
        List<Map<String, Object>> goals = mapper.selectGoals(query);
        var rows = new ArrayList<Map<String, Object>>(goals.size());
        if (!goals.isEmpty()) {
            var attainmentQuery = query(grant, new Filters(null, null, null, null, null, null,
                    null, null, null, null, null, null, null, null));
            List<Map<String, Object>> people = mapper.selectFindingAttainments(attainmentQuery);
            var events = new LinkedHashMap<String, List<Map<String, Object>>>();
            for (var entry : mapper.selectStageAttainments(attainmentQuery)) {
                events.computeIfAbsent(text(entry, "personId"), unused -> new ArrayList<>()).add(entry);
            }
            String manpikId = stages.stream().filter(item -> normalize(text(item, "name")).equals("만픽"))
                    .map(item -> text(item, "code")).findFirst().orElse("");
            var byStage = new LinkedHashMap<String, List<Attainment>>();
            Predicate<DistrictKey> visible = enforcer.visibility(grant);
            for (var goal : goals) {
                var row = new LinkedHashMap<>(goal);
                LocalDate from = date(text(goal, "from"));
                LocalDate to = date(text(goal, "to"));
                row.put("from", from);
                row.put("to", to);
                String stageId = text(goal, "stageId");
                String stageName = text(goal, "stageName");
                String stage = normalize(stageName.isEmpty() ? stageId : stageName);
                int actual = (int) byStage.computeIfAbsent(stageId, unused -> people.stream()
                        .map(person -> attainment(person, events.getOrDefault(text(person, "personId"), List.of()),
                                stageId, stage, manpikId))
                        .filter(Objects::nonNull)
                        .filter(entry -> visible.test(key(entry.region(), entry.district())))
                        .toList()).stream()
                        .filter(entry -> !entry.date().isBefore(from) && !entry.date().isAfter(to)
                                && goalIncludes(goal, entry))
                        .count();
                int target = number(goal, "target");
                row.put("actual", actual);
                row.put("shortfall", Math.max(0, target - actual));
                row.put("rate", target == 0 ? null : 100.0 * actual / target);
                rows.add(row);
            }
        }
        var observedClasses = new ArrayList<>(mapper.selectOrganizationMembers(query(grant, filters)));
        observedClasses.addAll(goals);
        List<String> classes = observedClasses.stream()
                .map(row -> text(row, "className")).filter(name -> !name.isEmpty()).distinct().sorted().toList();
        return Map.of("items", rows, "districts", districts(grant), "stages", stages, "classes", classes);
    }

    record Attainment(LocalDate date, String region, String district, String className) {
    }

    static Attainment attainment(Map<String, Object> person, List<Map<String, Object>> events,
            String stageId, String stage, String manpikId) {
        LocalDate found = date(text(person, "date"));
        if (stageId.isEmpty()) {
            return found == null ? null : attainmentAt(found, person);
        }
        List<Map<String, Object>> matching = events.stream().filter(event -> text(event, "stageId").equals(stageId)).toList();
        var entry = matching.isEmpty() ? null : matching.getFirst();
        String milestone = MILESTONES.get(stage);
        LocalDate explicit = milestone == null ? null : date(text(person, milestone));
        if ("bokshinDate".equals(milestone)) {
            entry = matching.stream().filter(event -> knownEntry(event, person)
                            && !stageId.equals(text(event, "fromStage")) && !text(event, "date").isEmpty())
                    .sorted(java.util.Comparator.comparing(event -> text(event, "date")))
                    .findFirst().orElse(null);
            if (explicit != null) {
                LocalDate day = explicit;
                entry = matching.stream().filter(event -> day.toString().equals(text(event, "date"))
                                && knownEntry(event, person) && !stageId.equals(text(event, "fromStage")))
                        .findFirst().orElse(entry);
            }
        }
        LocalDate reached = explicit != null ? explicit
                : knownEntry(entry, person) ? date(text(entry, "date")) : null;
        if ("찾b".equals(stage) && found != null) {
            if (reached != null && entry != null && text(entry, "fromStage").isEmpty()) {
                return attainmentAt(found, entry);
            }
            if (reached == null || found.isBefore(reached)) {
                LocalDate manpik = date(text(person, "manpikDate"));
                if (manpik == null) {
                    manpik = events.stream().filter(event -> text(event, "stageId").equals(manpikId)).findFirst()
                            .filter(event -> knownEntry(event, person))
                            .map(event -> date(text(event, "date"))).orElse(null);
                }
                if (found.equals(manpik)) {
                    return attainmentAt(found, person);
                }
            }
        }
        if (reached == null) {
            return null;
        }
        return entry != null ? attainmentAt(reached, entry)
                : new Attainment(reached, text(person, "currentRegionCode"), text(person, "currentDistrictCode"),
                        text(person, "currentClassName"));
    }

    private static Attainment attainmentAt(LocalDate date, Map<String, Object> row) {
        return new Attainment(date, text(row, "regionCode"), text(row, "districtCode"), text(row, "className"));
    }

    private static boolean knownEntry(Map<String, Object> event, Map<String, Object> person) {
        String firstReport = text(person, "firstReportStatus");
        return event != null && !"Y".equals(text(event, "baseline"))
                && !(text(event, "fromStage").isEmpty() && "일보 최초 확인".equals(text(event, "reason"))
                        && !firstReport.isEmpty() && !"신규".equals(firstReport));
    }

    private static boolean goalIncludes(Map<String, Object> goal, Attainment attainment) {
        String region = text(goal, "regionCode");
        String district = text(goal, "districtCode");
        String className = text(goal, "className");
        return (district.isEmpty() || (region.equals(attainment.region()) && district.equals(attainment.district())))
                && (className.isEmpty() || normalize(className).equals(normalize(attainment.className())));
    }

    public Map<String, Object> regionalActivity(AccessGrant grant, Filters filters) {
        String mode = Objects.requireNonNullElse(optional(filters.mode(), 10), "all");
        if (!List.of("all", "month", "day", "range").contains(mode)) {
            throw ApiException.badRequest("INVALID_ACTIVITY_MODE", "조회 기준을 확인해 주세요.");
        }
        var query = query(grant, filters);
        LocalDate now = LocalDate.now(SEOUL);
        if ("month".equals(mode)) {
            query.put("month", filters.month() == null ? YearMonth.from(now).toString() : month(filters.month()));
        } else if ("day".equals(mode)) {
            query.put("date", filters.date() == null ? now : date(filters.date()));
        } else if ("range".equals(mode) && (query.get("from") == null || query.get("to") == null)) {
            throw ApiException.badRequest("INVALID_DATE_RANGE", "시작일과 종료일을 지정해 주세요.");
        }
        List<Map<String, Object>> records = mapper.selectRegionalRecords(query);
        List<Map<String, Object>> members = mapper.selectOrganizationMembers(query);
        var active = new LinkedHashMap<String, Map<String, Object>>();
        for (var member : members) {
            if (activeMember(member)) {
                active.put(text(member, "id"), member);
            }
        }
        List<Map<String, Object>> items;
        if ("all".equals(mode)) {
            items = records;
        } else {
            var perMember = new LinkedHashMap<String, Map<String, Object>>();
            for (var record : records) {
                String memberId = text(record, "memberId");
                if ("range".equals(mode) && !active.containsKey(memberId)) {
                    continue;
                }
                var previous = perMember.get(memberId);
                if (previous == null || ("range".equals(mode) && number(record, "status") < number(previous, "status"))) {
                    perMember.put(memberId, record);
                }
            }
            active.forEach((memberId, member) -> perMember.computeIfAbsent(memberId, unused -> unrecorded(memberId, member)));
            items = new ArrayList<>(perMember.values());
        }
        var buckets = new LinkedHashMap<String, Integer>();
        for (String label : ACTIVITY_LABELS) {
            buckets.put(label, 0);
        }
        for (var row : items) {
            buckets.merge(ACTIVITY_LABELS.get(number(row, "status")), 1, Integer::sum);
        }
        if (filters.status() != null) {
            if (filters.status() < 0 || filters.status() > 4) {
                throw ApiException.badRequest("INVALID_ACTIVITY_STATUS", "활동 상태를 확인해 주세요.");
            }
            items = items.stream().filter(row -> number(row, "status") == filters.status()).toList();
        }
        var normalized = new ArrayList<Map<String, Object>>(items.size());
        for (var item : items) {
            var row = new LinkedHashMap<>(item);
            row.put("date", date(text(item, "date")));
            row.put("statusName", ACTIVITY_LABELS.get(number(row, "status")));
            normalized.add(row);
        }
        return Map.of("items", normalized, "counts", buckets, "districts", districts(grant), "today", now,
                "members", active.values());
    }

    private static Map<String, Object> unrecorded(String id, Map<String, Object> member) {
        var row = new LinkedHashMap<String, Object>();
        row.put("memberId", id);
        row.put("memberName", member.get("name"));
        row.put("memberCode", member.get("code"));
        for (String key : List.of("regionCode", "districtCode", "regionName", "districtName")) {
            row.put(key, member.get(key));
        }
        row.put("status", 0);
        return row;
    }

    public Map<String, Object> socialing(AccessGrant grant, Filters filters) {
        var query = query(grant, filters);
        String search = optional(filters.q(), 120);
        query.put("search", search == null ? null : search.toLowerCase(Locale.ROOT));
        String status = optional(filters.socialStatus(), 20);
        if (status != null && !List.of("pending", "converted").contains(status)) {
            throw ApiException.badRequest("INVALID_SOCIAL_STATUS", "진행 상태를 확인해 주세요.");
        }
        query.put("socialStatus", status);
        List<Map<String, Object>> raw = mapper.selectSocialInflows(query);
        var rows = new ArrayList<Map<String, Object>>(raw.size());
        int converted = 0;
        for (var item : raw) {
            var row = new LinkedHashMap<>(item);
            row.put("date", date(text(item, "date")));
            if ("converted".equals(text(row, "status"))) {
                converted++;
            }
            rows.add(row);
        }
        return Map.of("programs", mapper.selectSocialPrograms(query), "items", rows, "total", rows.size(),
                "converted", converted, "pending", rows.size() - converted, "districts", districts(grant));
    }

    public Map<String, Object> socialingStats(AccessGrant grant, Filters filters) {
        var query = query(grant, filters);
        var rows = mapper.selectSocialStats(query);
        int total = rows.stream().mapToInt(row -> number(row, "total")).sum();
        int converted = rows.stream().mapToInt(row -> number(row, "converted")).sum();
        return Map.of("programs", mapper.selectSocialPrograms(query), "items", rows, "total", total,
                "converted", converted, "pending", total - converted, "districts", districts(grant));
    }

    List<Map<String, Object>> districts(AccessGrant grant) {
        Predicate<DistrictKey> visible = enforcer.visibility(grant);
        var names = new LinkedHashMap<String, String>();
        reference.regions().forEach(region -> names.put(region.regionCode(), region.name()));
        return reference.districts().stream().filter(district -> visible.test(district.key())).map(district ->
                Map.<String, Object>of("regionCode", district.key().regionCode(), "districtCode", district.key().districtCode(),
                        "regionName", names.getOrDefault(district.key().regionCode(), ""), "districtName", district.name(),
                        "active", district.active())).toList();
    }

    Map<String, Object> query(AccessGrant grant, Filters filters) {
        var scope = enforcer.effectiveScope(grant);
        String region = optional(filters.regionCode(), 60);
        String district = optional(filters.districtCode(), 60);
        if ((region != null || district != null) && !DistrictKey.valid(region, district)) {
            throw ApiException.badRequest("INVALID_DISTRICT", "지역과 구역을 함께 지정해 주세요.");
        }
        if (district != null && !scope.allows(new DistrictKey(region, district))) {
            throw ApiException.forbidden("OUT_OF_SCOPE", "접근할 수 없는 구역입니다.");
        }
        LocalDate from = date(filters.from());
        LocalDate to = date(filters.to());
        if (from != null && to != null && from.isAfter(to)) {
            throw ApiException.badRequest("INVALID_DATE_RANGE", "시작일은 종료일보다 늦을 수 없습니다.");
        }
        var q = new LinkedHashMap<String, Object>();
        q.put("libraryId", library.id());
        q.put("unassigned", scope.type() == ScopeType.ALL);
        q.put("districts", scope.districts());
        q.put("regionCode", region);
        q.put("districtCode", district);
        q.put("from", from);
        q.put("to", to);
        q.put("fromMonth", from == null ? null : YearMonth.from(from).plusMonths(from.getDayOfMonth() == 1 ? 0 : 1).toString());
        q.put("toMonth", to == null ? null : YearMonth.from(to).minusMonths(to.getDayOfMonth() == to.lengthOfMonth() ? 0 : 1).toString());
        q.put("className", optional(filters.className(), 60));
        q.put("stage", optional(filters.stage(), 60));
        q.put("programId", optional(filters.programId(), 60));
        return q;
    }

    static String text(Map<String, Object> row, String field) {
        return Objects.toString(row.get(field), "");
    }

    static int number(Map<String, Object> row, String field) {
        return ((Number) row.get(field)).intValue();
    }

    static boolean activeMember(Map<String, Object> row) {
        return "Y".equals(text(row, "useInd")) && !"inactive".equalsIgnoreCase(text(row, "status"));
    }

    static String normalize(String text) {
        return text.replaceAll("\\s+", "").toLowerCase(Locale.ROOT);
    }

    static DistrictKey key(String region, String district) {
        return region.isBlank() || district.isBlank() ? null : new DistrictKey(region, district);
    }

    static String optional(String value, int max) {
        if (value == null || value.isBlank()) {
            return null;
        }
        String trimmed = value.strip();
        if (trimmed.length() > max) {
            throw ApiException.badRequest("INVALID_FILTER", "입력값이 너무 깁니다.");
        }
        return trimmed;
    }

    static LocalDate date(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            if (!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) {
                throw new DateTimeParseException("invalid date", value, 0);
            }
            LocalDate day = LocalDate.parse(value);
            if (day.getYear() < 1000) {
                throw new DateTimeParseException("invalid date", value, 0);
            }
            return day;
        } catch (DateTimeParseException error) {
            throw ApiException.badRequest("INVALID_DATE", "날짜는 YYYY-MM-DD 형식으로 입력해 주세요.");
        }
    }

    static String month(String value) {
        try {
            if (!value.matches("[0-9]{4}-[0-9]{2}")) {
                throw new DateTimeParseException("invalid month", value, 0);
            }
            YearMonth month = YearMonth.parse(value);
            if (month.getYear() < 1000) {
                throw new DateTimeParseException("invalid month", value, 0);
            }
            return month.toString();
        } catch (DateTimeParseException error) {
            throw ApiException.badRequest("INVALID_MONTH", "월은 YYYY-MM 형식으로 입력해 주세요.");
        }
    }
}
