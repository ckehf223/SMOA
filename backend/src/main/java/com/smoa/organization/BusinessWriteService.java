package com.smoa.organization;

import static com.smoa.organization.BusinessService.key;
import static com.smoa.organization.BusinessService.optional;
import static com.smoa.organization.BusinessService.text;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Function;

import org.springframework.context.annotation.Profile;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.smoa.access.AccessGrant;
import com.smoa.audit.AuditStamp;
import com.smoa.common.ApiException;
import com.smoa.config.LibraryContext;
import com.smoa.module.mapper.RecordsMapper;
import com.smoa.organization.BusinessService.Filters;
import com.smoa.organization.persistence.BusinessMapper;
import com.smoa.permission.DistrictKey;
import com.smoa.records.HistoryEntry;
import com.smoa.records.RecordRepository;
import com.smoa.scope.ScopeEnforcer;

@Service
@Profile({"local", "prod"})
@Transactional
public class BusinessWriteService {
    private static final Filters NO_FILTERS = new Filters(null, null, null, null, null, null,
            null, null, null, null, null, null, null, null);

    private final BusinessMapper mapper;
    private final BusinessService read;
    private final RecordsMapper records;
    private final RecordRepository history;
    private final LibraryContext library;
    private final ScopeEnforcer enforcer;

    public BusinessWriteService(BusinessMapper mapper, BusinessService read, RecordsMapper records,
            RecordRepository history, LibraryContext library, ScopeEnforcer enforcer) {
        this.mapper = mapper;
        this.read = read;
        this.records = records;
        this.history = history;
        this.library = library;
        this.enforcer = enforcer;
    }

    public record MemberInput(String name, String code, String regionCode, String districtCode, String className,
            String title, String job, String status, String useInd, String version) {
    }

    public Map<String, String> saveMember(AccessGrant grant, String id, MemberInput input) {
        var arguments = begin(grant, optional(id, 60));
        if (id != null) {
            checkVersion(arguments, mapper::selectOrganizationMembers, input.version());
        }
        var district = assign(grant, arguments, input.regionCode(), input.districtCode());
        arguments.put("name", required(input.name(), 60, "이름"));
        arguments.put("code", optional(input.code(), 60));
        arguments.put("className", optional(input.className(), 60));
        arguments.put("title", optional(input.title(), 60));
        arguments.put("job", Objects.requireNonNullElse(optional(input.job(), 20), "0"));
        arguments.put("status", Objects.requireNonNullElse(optional(input.status(), 20), "2"));
        String use = Objects.requireNonNullElse(optional(input.useInd(), 1), "Y");
        if (!List.of("Y", "N").contains(use)) {
            throw ApiException.badRequest("INVALID_USE_IND", "사용 여부를 확인해 주세요.");
        }
        arguments.put("useInd", use);
        if (id == null) {
            arguments.put("id", UUID.randomUUID().toString());
            mapper.insertMember(arguments);
        } else {
            checkRows(mapper.updateMember(arguments));
        }
        return recorded(arguments, district, "member", id == null ? "create" : "update");
    }

    public void archiveMember(AccessGrant grant, String id, String version) {
        var arguments = begin(grant, required(id, 60, "구성원"));
        var current = checkVersion(arguments, mapper::selectOrganizationMembers, version);
        checkRows(mapper.archiveMember(arguments));
        recorded(arguments, district(current), "member", "archive");
    }

    public record GoalInput(String regionCode, String districtCode, String className, LocalDate from, LocalDate to,
            String stageId, String periodUnit, Integer target, String version) {
    }

    public Map<String, String> saveGoal(AccessGrant grant, String id, GoalInput input) {
        var arguments = begin(grant, numericId(id));
        var current = id == null ? Map.<String, Object>of() : checkVersion(arguments, mapper::selectGoals, input.version());
        var district = assign(grant, arguments, input.regionCode(), input.districtCode());
        if (input.from() == null || input.to() == null || input.from().isAfter(input.to())
                || input.from().getYear() < 1000 || input.to().getYear() > 9999) {
            throw ApiException.badRequest("INVALID_DATE_RANGE", "유효한 시작일과 종료일을 입력해 주세요.");
        }
        String period = required(input.periodUnit(), 10, "기간 구분");
        if (!List.of("week", "month", "custom").contains(period)) {
            throw ApiException.badRequest("INVALID_PERIOD", "기간 구분을 확인해 주세요.");
        }
        if (input.target() == null || input.target() < 0 || input.target() > 23_000_000) {
            throw ApiException.badRequest("INVALID_TARGET", "목표를 0~23,000,000 사이의 정수로 입력해 주세요.");
        }
        String stage = optional(input.stageId(), 60);
        if (stage != null && !stage.equals(text(current, "stageId")) && mapper.selectCodes(arguments).stream()
                .noneMatch(row -> "STAGE".equals(text(row, "groupCode")) && stage.equals(text(row, "code"))
                        && "Y".equals(text(row, "useInd")))) {
            throw ApiException.badRequest("INVALID_STAGE", "사용 중인 단계를 선택해 주세요.");
        }
        String className = optional(input.className(), 60);
        if (district == null && className == null && id == null) {
            throw ApiException.badRequest("INVALID_GOAL_SCOPE", "목표 구역 또는 반을 입력해 주세요.");
        }
        arguments.put("className", className);
        arguments.put("from", input.from());
        arguments.put("to", input.to());
        arguments.put("stageId", stage);
        arguments.put("periodUnit", period);
        arguments.put("target", input.target());
        if (mapper.countDuplicateGoals(arguments) > 0) {
            throw ApiException.conflict("GOAL_DUPLICATE", "같은 구역·반·기간·단계에 이미 목표가 있습니다.");
        }
        if (id == null) {
            mapper.insertGoal(arguments);
        } else {
            checkRows(mapper.updateGoal(arguments));
        }
        return recorded(arguments, district, "goal", id == null ? "create" : "update");
    }

    public void deleteGoal(AccessGrant grant, String id, String version) {
        var arguments = begin(grant, numericId(id));
        var current = checkVersion(arguments, mapper::selectGoals, version);
        checkRows(mapper.deleteGoal(arguments));
        recorded(arguments, district(current), "goal", "delete");
    }

    public record ActivityInput(String memberId, LocalDate date, String month, Integer status, String version) {
    }

    public Map<String, String> saveActivity(AccessGrant grant, String id, ActivityInput input) {
        if (input.status() == null || input.status() < 1 || input.status() > 4) {
            throw ApiException.badRequest("INVALID_ACTIVITY_STATUS", "활동 상태를 확인해 주세요.");
        }
        var arguments = begin(grant, numericId(id));
        arguments.put("status", input.status());
        if (id != null) {
            var current = checkVersion(arguments, mapper::selectRegionalRecords, input.version());
            checkRows(mapper.updateRegionalRecord(arguments));
            return recorded(arguments, district(current), "regionalActivity", "update");
        }
        arguments.put("id", required(input.memberId(), 60, "구성원"));
        var member = find(arguments, mapper::selectOrganizationMembers);
        arguments.remove("id");
        if (!BusinessService.activeMember(member)) {
            throw ApiException.badRequest("INACTIVE_MEMBER", "사용 중인 구성원을 선택해 주세요.");
        }
        if (input.date() != null && (input.date().getYear() < 1000 || input.date().getYear() > 9999)) {
            throw ApiException.badRequest("INVALID_DATE", "활동일을 확인해 주세요.");
        }
        String month = input.date() == null ? BusinessService.month(required(input.month(), 7, "활동월"))
                : YearMonth.from(input.date()).toString();
        arguments.put("memberId", member.get("id"));
        arguments.put("memberCode", member.get("code"));
        arguments.put("memberName", member.get("name"));
        arguments.put("date", input.date());
        arguments.put("month", month);
        arguments.put("period", input.date() == null ? month : input.date().toString());
        var district = assign(grant, arguments, text(member, "regionCode"), text(member, "districtCode"));
        try {
            mapper.insertRegionalRecord(arguments);
        } catch (DuplicateKeyException error) {
            throw ApiException.conflict("ACTIVITY_DUPLICATE", "이 구성원의 해당 기간 활동이 이미 등록되었습니다.");
        }
        return recorded(arguments, district, "regionalActivity", "create");
    }

    public void deleteActivity(AccessGrant grant, String id, String version) {
        var arguments = begin(grant, numericId(id));
        var current = checkVersion(arguments, mapper::selectRegionalRecords, version);
        checkRows(mapper.deleteRegionalRecord(arguments));
        recorded(arguments, district(current), "regionalActivity", "delete");
    }

    private Map<String, Object> begin(AccessGrant grant, String id) {
        if (records.lockLibrary(library.id()).isEmpty()) {
            throw new IllegalStateException("자료실을 찾을 수 없습니다.");
        }
        var arguments = read.query(grant, NO_FILTERS);
        arguments.put("id", id);
        arguments.put("stamp", AuditStamp.current());
        return arguments;
    }

    private DistrictKey assign(AccessGrant grant, Map<String, Object> arguments, String region, String district) {
        String regionCode = optional(region, 60);
        String districtCode = optional(district, 60);
        if ((regionCode != null || districtCode != null) && !DistrictKey.valid(regionCode, districtCode)) {
            throw ApiException.badRequest("INVALID_DISTRICT", "지역과 구역을 함께 지정해 주세요.");
        }
        DistrictKey key = regionCode == null ? null : new DistrictKey(regionCode, districtCode);
        if (!enforcer.visible(grant, key)) {
            throw ApiException.forbidden("OUT_OF_SCOPE", "접근할 수 없는 구역입니다.");
        }
        arguments.put("newRegion", regionCode);
        arguments.put("newDistrict", districtCode);
        return key;
    }

    private static DistrictKey district(Map<String, Object> row) {
        return key(text(row, "regionCode"), text(row, "districtCode"));
    }

    private static Map<String, Object> find(Map<String, Object> arguments,
            Function<Map<String, Object>, List<Map<String, Object>>> select) {
        return select.apply(arguments).stream().findFirst().orElseThrow(() -> ApiException.notFound("자료를 찾을 수 없습니다."));
    }

    private static Map<String, Object> checkVersion(Map<String, Object> arguments,
            Function<Map<String, Object>, List<Map<String, Object>>> select, String version) {
        var row = find(arguments, select);
        if (!text(row, "version").equals(version)) {
            checkRows(0);
        }
        try {
            arguments.put("version", LocalDateTime.parse(version));
        } catch (DateTimeParseException error) {
            throw ApiException.badRequest("INVALID_VERSION", "자료를 새로 조회해 주세요.");
        }
        return row;
    }

    private static void checkRows(int affected) {
        if (affected != 1) {
            throw ApiException.conflict("WRITE_CONFLICT", "다른 작업에서 자료가 변경되었습니다. 새로 조회해 주세요.");
        }
    }

    private Map<String, String> recorded(Map<String, Object> arguments, DistrictKey key, String kind, String action) {
        var stamp = (AuditStamp) arguments.get("stamp");
        String id = text(arguments, "id");
        var entry = new HistoryEntry(null, HistoryEntry.KIND_CHANGE, null, key, HistoryEntry.UPDATED,
                null, null, null, null, true, false, null, stamp.userId(), stamp.userName(),
                stamp.utcNow().atOffset(ZoneOffset.UTC).toString(), kind + "." + action, kind, id);
        history.appendHistory(entry, null, null);
        return Map.of("id", id);
    }

    private static String required(String value, int maximum, String label) {
        String result = optional(value, maximum);
        if (result == null) {
            throw ApiException.badRequest("REQUIRED_VALUE", label + " 값을 입력해 주세요.");
        }
        return result;
    }

    private static String numericId(String id) {
        if (id == null) {
            return null;
        }
        try {
            if (id.matches("[1-9][0-9]{0,19}") && Long.parseUnsignedLong(id) != 0) {
                return id;
            }
        } catch (NumberFormatException error) {
            // Oversized numeric IDs have the same response as missing records.
        }
        throw ApiException.notFound("자료를 찾을 수 없습니다.");
    }
}
