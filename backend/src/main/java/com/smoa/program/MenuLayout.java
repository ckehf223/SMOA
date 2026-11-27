package com.smoa.program;

import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import com.smoa.common.ApiException;

/** 메뉴 폴더는 최대 두 단계다. 프로그램의 빈 경로는 폴더 밖 배치다. */
public record MenuLayout(List<Group> groups, List<Placement> placements) {
    public record Group(String path, int sortOrder) { }

    public record Placement(String programId, String group, int sortOrder) { }

    private static final Comparator<Group> GROUP_ORDER = Comparator.comparingInt(Group::sortOrder).thenComparing(Group::path);
    private static final Comparator<Placement> PROGRAM_ORDER = Comparator.comparingInt(Placement::sortOrder)
            .thenComparing(Placement::programId);
    private static final Set<String> DATA_VIEWS = Set.of("regionData", "memberData", "classData", "findingStats",
            "diagnostics", "stagePerformance", "callingStats", "socialingStats", "stages");
    private static final Set<String> BUILT_IN_PATHS = Set.of(
            "업무현황 / 대시보드", "업무현황 / 목표", "데이터현황 / 실적", "데이터현황 / 통계·진단",
            "소셜링 / 유입 관리", "소셜링 / 데이터현황", "콜링 / 콜링 업무", "콜링 / 데이터현황",
            "기록관리 / 대상자", "기록관리 / 활동", "기록관리 / 사후", "기록관리 / 이력",
            "자료작업 / 엑셀", "자료작업 / 일보", "관리 / 기준정보", "관리 / 계정·권한", "관리 / 시스템");
    private static final Set<String> BUILT_IN_PROGRAMS = Set.of("dashboard", "goals", "regionData", "memberData",
            "classData", "findingStats", "diagnostics", "stagePerformance", "socialingManage", "socialingStats",
            "callingManage", "callingStats", "callingSheet", "people", "activities", "regionalActivity", "afterAll",
            "afterOrganizer", "afterParticipant", "stages", "history", "reports", "daily", "organization", "codes",
            "users", "permissions", "programs", "settings");

    static MenuLayout resolve(List<Program> programs, Optional<List<Group>> saved, boolean includeEmpty) {
        Map<String, Group> configured = new HashMap<>();
        Map<String, Group> visible = new HashMap<>();
        saved.ifPresent(groups -> groups.forEach(group -> configured.put(group.path(), group)));
        if (includeEmpty) visible.putAll(configured);

        List<Placement> placements = programs.stream().map(program -> {
            String group = storedPath(program.group());
            int order = program.sortOrder();
            if (saved.isEmpty() && BUILT_IN_PROGRAMS.contains(program.programId())) {
                group = defaultPath(program.programId(), group);
                if ("dashboard".equals(program.programId()) && group.isEmpty()) order = 0;
            }
            return new Placement(program.programId(), group, order);
        }).sorted(PROGRAM_ORDER).toList();
        for (Placement entry : placements) {
            if (entry.group().isEmpty()) continue;
            addPath(entry.group(), entry.sortOrder(), configured, visible);
            String parent = parent(entry.group());
            if (!parent.isEmpty()) addPath(parent, entry.sortOrder(), configured, visible);
        }
        return new MenuLayout(visible.values().stream().sorted(GROUP_ORDER).toList(), placements);
    }

    private static void addPath(String path, int order, Map<String, Group> configured, Map<String, Group> visible) {
        visible.putIfAbsent(path, configured.getOrDefault(path, new Group(path, order)));
    }

    static String normalizePath(String path) {
        if (path.isBlank()) return "";
        List<String> parts = Arrays.stream(path.split("/", -1)).map(String::strip).toList();
        if (parts.size() > 2 || parts.stream().anyMatch(name -> name.isEmpty()
                || name.codePoints().anyMatch(Character::isISOControl))) {
            throw ApiException.badRequest("INVALID_PROGRAM_GROUP", "메뉴 폴더 경로는 최대 두 단계까지 지정할 수 있습니다.");
        }
        String normalized = String.join(" / ", parts);
        if (normalized.length() > 30) {
            throw ApiException.badRequest("INVALID_PROGRAM_GROUP", "전체 메뉴 경로는 30자 이하여야 합니다.");
        }
        return normalized;
    }

    static String parent(String path) {
        int separator = path.lastIndexOf(" / ");
        return separator < 0 ? "" : path.substring(0, separator);
    }

    private static String storedPath(String path) {
        if (path == null) return "";
        try {
            return normalizePath(path);
        } catch (ApiException e) {
            // 초기 카탈로그의 자유 입력 그룹도 표시할 수 있게 전체 경로를 한 폴더 이름으로 읽는다.
            String cleaned = path.strip().replace('/', '·').replaceAll("\\p{Cc}", " ");
            return cleaned.length() > 30 ? cleaned.substring(0, 30).stripTrailing() : cleaned;
        }
    }

    private static String defaultPath(String programId, String path) {
        if ("dashboard".equals(programId)
                && (path.isEmpty() || path.equals("최상위") || path.equals("업무현황") || path.equals("업무현황 / 대시보드"))) {
            return "";
        }
        if (DATA_VIEWS.contains(programId) && (BUILT_IN_PATHS.contains(path)
                || Set.of("데이터현황", "콜링", "소셜링", "기록관리").contains(path))) return "데이터현황";
        if ("goals".equals(programId)
                && Set.of("업무현황 / 목표", "업무현황", "최상위").contains(path)) return "목표";
        if (path.equals("기록관리 / 사후")) return "사후";
        if (BUILT_IN_PATHS.contains(path)) return parent(path);
        return path.equals("관리설정") ? "관리" : path;
    }
}
