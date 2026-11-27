package com.smoa.afterreport;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.smoa.access.AccessGrant;
import com.smoa.afterreport.AfterReportData.Analysis;
import com.smoa.afterreport.AfterReportData.DistrictOption;
import com.smoa.afterreport.AfterReportData.Draft;
import com.smoa.afterreport.AfterReportData.Filter;
import com.smoa.afterreport.AfterReportData.Options;
import com.smoa.afterreport.AfterReportData.Page;
import com.smoa.afterreport.AfterReportData.Payload;
import com.smoa.afterreport.AfterReportData.Report;
import com.smoa.afterreport.AfterReportData.ReportKey;
import com.smoa.afterreport.AfterReportData.Role;
import com.smoa.afterreport.AfterReportData.Submission;
import com.smoa.afterreport.AfterReportData.TimeRange;
import com.smoa.common.ApiException;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.program.ProgramAction;
import com.smoa.reference.Region;
import com.smoa.reference.ReferenceRepository;
import com.smoa.scope.ScopeEnforcer;

@Service
public class AfterReportService {
    public static final String ALL = "afterAll";
    public static final String ORGANIZER = "afterOrganizer";
    public static final String PARTICIPANT = "afterParticipant";
    private static final List<String> SLOTS = List.of("1타임", "2타임", "3타임", "4타임", "그 외");
    private static final List<String> ORGANIZER_SLOTS = List.of("1타임", "2타임", "3타임", "그 외");
    private static final List<String> LOCATIONS = List.of("강동", "건대", "광나루", "구리", "군자", "길동", "둔촌동",
            "미사", "송파", "어린이대공원", "왕십리", "자양역", "잠실", "천호");
    private static final List<String> ORGANIZER_CHECKS = List.of("묵상 말씀 준비를 하였는가?", "인원 목표를 확인했는가?",
            "분위기를 살펴보며 독려하였는가?", "2인 1조 짝을 잘 지었는가?");
    private static final List<String> PARTICIPANT_CHECKS = List.of("나는 긍정적, 할 수 있다는 마음으로 뛰었는가?",
            "혼자 다니지 않고 같이 활동했는가?", "옆사람을 독려했는가?", "목표건을 도달했는가?");
    private static final Pattern DATE = Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}");
    private static final Pattern TIME = Pattern.compile("(?:[01][0-9]|2[0-3]):[0-5][0-9]");

    private final AfterReportRepository repository;
    private final ReferenceRepository reference;
    private final ScopeEnforcer enforcer;

    public AfterReportService(AfterReportRepository repository, ReferenceRepository reference, ScopeEnforcer enforcer) {
        this.repository = repository;
        this.reference = reference;
        this.enforcer = enforcer;
    }

    public Options options(AccessGrant grant, String programId) {
        Role role = permit(grant, programId, false);
        DataScope allowed = enforcer.effectiveScope(grant);
        Map<String, String> regions = reference.regions().stream()
                .collect(Collectors.toMap(Region::regionCode, Region::name));
        List<DistrictOption> districts = reference.districts().stream().filter(d -> allowed.allows(d.key()))
                .map(d -> new DistrictOption(d.key().regionCode(), d.key().districtCode(),
                        regions.getOrDefault(d.key().regionCode(), d.key().regionCode()) + " / " + d.name()))
                .toList();
        return new Options(districts, role == Role.ORGANIZER ? ORGANIZER_SLOTS : SLOTS, LOCATIONS,
                ORGANIZER_CHECKS, PARTICIPANT_CHECKS);
    }

    public Page page(AccessGrant grant, String programId, String from, String to, String regionCode,
            String districtCode, int page, int size) {
        Role role = permit(grant, programId, false);
        if (size < 1 || size > 200 || page < 1) {
            throw invalid("조회 기간 또는 페이지 범위를 확인해 주세요.");
        }
        Filter filter = filter(grant, from, to, regionCode, districtCode, role, page, size);
        if (filter.districts().isEmpty()) {
            return new Page(List.of(), 0, page, size);
        }
        var result = repository.find(filter);
        return new Page(result.items().stream().map(Report::from).toList(), result.total(), page, size);
    }

    public Analysis analysis(AccessGrant grant, String programId, String from, String to, String regionCode,
            String districtCode) {
        if (!ALL.equals(programId)) {
            throw ApiException.notFound("사후 분석 화면을 찾을 수 없습니다.");
        }
        permit(grant, programId, false);
        Filter filter = filter(grant, from, to, regionCode, districtCode, null, 1, 1);
        var totals = new AfterReportAnalysis(PARTICIPANT_CHECKS);
        if (!filter.districts().isEmpty()) {
            repository.visit(filter, totals::add);
        }
        return totals.result();
    }

    private Filter filter(AccessGrant grant, String from, String to, String regionCode, String districtCode,
            Role role, int page, int size) {
        LocalDate begin = optionalDate(from);
        LocalDate end = optionalDate(to);
        if (begin != null && end != null && end.isBefore(begin)) {
            throw invalid("조회 기간 또는 페이지 범위를 확인해 주세요.");
        }
        DataScope allowed = enforcer.effectiveScope(grant);
        List<DistrictKey> districts;
        if (regionCode != null || districtCode != null) {
            DistrictKey selected = key(regionCode, districtCode);
            districts = allowed.allows(selected) ? List.of(selected) : List.of();
        } else {
            districts = allowed.districts().stream().sorted().toList();
        }
        return new Filter(begin, end, districts, role, page, size);
    }

    public Report save(AccessGrant grant, String programId, Submission body) {
        Role role = permit(grant, programId, true);
        if (body == null) {
            throw invalid("보고 내용을 입력해 주세요.");
        }
        DistrictKey district = key(body.regionCode(), body.districtCode());
        if (!enforcer.visible(grant, district)) {
            throw ApiException.forbidden("OUT_OF_SCOPE", "접근할 수 없는 구역입니다.");
        }
        LocalDate date = date(body.date());
        String slot = body.slot();
        if (slot == null || !(role == Role.ORGANIZER ? ORGANIZER_SLOTS : SLOTS).contains(slot)) {
            throw invalid("활동 타임을 선택해 주세요.");
        }
        Payload payload = payload(role, body);
        return Report.from(repository.save(new Draft(new ReportKey(date, slot, district, role), payload,
                grant.accountId())));
    }

    private static Role permit(AccessGrant grant, String programId, boolean write) {
        Role role = switch (programId) {
            case ORGANIZER -> Role.ORGANIZER;
            case PARTICIPANT -> Role.PARTICIPANT;
            case ALL -> null;
            default -> throw ApiException.notFound("사후 보고 화면을 찾을 수 없습니다.");
        };
        if (!grant.canAll(programId, ProgramAction.ACCESS, ProgramAction.READ)
                || (write && (role == null || !grant.can(programId, ProgramAction.WRITE)))) {
            throw ApiException.forbidden("FORBIDDEN", "사후 보고에 접근할 권한이 없습니다.");
        }
        return role;
    }

    private static Payload payload(Role role, Submission body) {
        String location = value(body.location(), 80, true, true, "활동 장소");
        String name = value(body.name(), 80, true, true, "성명");
        List<TimeRange> ranges = ranges(role, body.timeRanges());
        int findings = count(body.findings(), "찾기 건수");
        if (role == Role.ORGANIZER) {
            if (body.participantScores() != null || body.remarks() != null) {
                throw invalid("주관자 보고 항목을 확인해 주세요.");
            }
            List<JsonNode> checks = body.organizerChecklist();
            if (checks == null || checks.size() != ORGANIZER_CHECKS.size()
                    || checks.stream().anyMatch(value -> value == null || !value.isBoolean())) {
                throw invalid("주관자 체크리스트를 모두 선택해 주세요.");
            }
            JsonNode personal = body.personalFindings();
            return new Payload(location, name, ranges, findings, count(body.headcount(), "활동 인원"),
                    absent(personal) ? null : count(personal, "본인 찾기 건수"),
                    value(body.potionName(), 80, false, true, "물약 포지션"),
                    checks.stream().map(JsonNode::booleanValue).toList(),
                    value(body.notes(), 1500, false, false, "특이사항"), null, null);
        }
        if (!absent(body.headcount()) || !absent(body.personalFindings()) || body.potionName() != null
                || body.organizerChecklist() != null || body.notes() != null) {
            throw invalid("활동자 보고 항목을 확인해 주세요.");
        }
        List<JsonNode> scores = body.participantScores();
        if (scores == null || scores.size() != PARTICIPANT_CHECKS.size()
                || scores.stream().anyMatch(score -> !integer(score) || score.intValue() < 1 || score.intValue() > 3)) {
            throw invalid("활동자 체크리스트의 점수를 모두 선택해 주세요(1~3점).");
        }
        return new Payload(location, name, ranges, findings, null, null, null, null, null,
                scores.stream().map(JsonNode::intValue).toList(),
                value(body.remarks(), 1500, false, false, "비고"));
    }

    private static List<TimeRange> ranges(Role role, List<TimeRange> source) {
        if (source == null || source.isEmpty() || source.size() > 24
                || (role == Role.ORGANIZER && source.size() != 1)) {
            throw invalid("활동 시간 구간 수를 확인해 주세요.");
        }
        List<TimeRange> ranges = new ArrayList<>(source.size());
        for (TimeRange range : source) {
            if (range == null || range.start() == null || range.end() == null
                    || !TIME.matcher(range.start()).matches() || !TIME.matcher(range.end()).matches()
                    || range.start().compareTo(range.end()) >= 0) {
                throw invalid("시작·종료 시각을 확인해 주세요.");
            }
            ranges.add(range);
        }
        return List.copyOf(ranges);
    }

    private static DistrictKey key(String regionCode, String districtCode) {
        if (!DistrictKey.valid(regionCode, districtCode)) {
            throw invalid("지역과 구역을 함께 선택해 주세요.");
        }
        return new DistrictKey(regionCode, districtCode);
    }

    private static LocalDate optionalDate(String raw) {
        return raw == null || raw.isBlank() ? null : date(raw);
    }

    private static LocalDate date(String raw) {
        if (raw == null || !DATE.matcher(raw).matches()) {
            throw invalid("활동일을 확인해 주세요.");
        }
        try {
            LocalDate value = LocalDate.parse(raw);
            if (value.getYear() >= 1000) {
                return value;
            }
        } catch (DateTimeParseException ignored) {}
        throw invalid("활동일을 확인해 주세요.");
    }

    private static int count(JsonNode raw, String label) {
        if (!integer(raw) || raw.intValue() < 0) {
            throw invalid(label + "를 0 이상의 정수로 입력해 주세요.");
        }
        return raw.intValue();
    }

    private static boolean absent(JsonNode value) {
        return value == null || value.isNull();
    }

    private static boolean integer(JsonNode value) {
        return value != null && value.isIntegralNumber() && value.canConvertToInt();
    }

    private static String value(String raw, int max, boolean required, boolean singleLine, String label) {
        String trimmed = raw == null ? "" : raw.strip();
        if ((required && trimmed.isEmpty()) || trimmed.codePointCount(0, trimmed.length()) > max
                || trimmed.codePoints().anyMatch(c -> (Character.isISOControl(c)
                        && (singleLine || (c != '\n' && c != '\r' && c != '\t')))
                        || (singleLine && (c == 0x2028 || c == 0x2029)))) {
            throw invalid(label + " 입력을 확인해 주세요.");
        }
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static ApiException invalid(String message) {
        return ApiException.badRequest("INVALID_AFTER_REPORT", message);
    }
}
