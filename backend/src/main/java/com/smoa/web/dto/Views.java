package com.smoa.web.dto;

import java.util.List;
import java.util.Map;

import com.smoa.permission.ScopeType;
import com.smoa.program.MenuLayout;
import com.smoa.program.ProgramCategory;

/** 응답 DTO 모음. 비밀번호·해시·연락처 원문 필드는 어디에도 없다. */
public final class Views {

    private Views() {
    }

    public record PermissionView(boolean access, boolean read, boolean write, boolean export) {
    }

    public record DistrictView(String regionCode, String districtCode) {
    }

    public record DataScopeView(ScopeType type, List<DistrictView> districts) {
    }

    /** 사용자 메뉴 항목. 구현 세부(클래스·SQL)는 담지 않는다. */
    public record MenuItem(String programId, String name, String group, String page, String module,
            List<String> actions, int sortOrder) {
    }

    public record PackageRef(String packageId, String name) {
    }

    /** GET /api/auth/me 와 로그인 성공 응답. 본인 패키지만 포함하며 다른 패키지 권한은 노출하지 않는다. */
    public record MeResponse(
            String accountId,
            String username,
            String displayName,
            PackageRef pkg,
            boolean packageActive,
            boolean admin,
            boolean noMenu,
            List<MenuItem> menus,
            List<MenuLayout.Group> menuGroups,
            Map<String, PermissionView> permissions,
            DataScopeView dataScope,
            String storageMode,
            boolean devMemory) {
    }

    // ---- 총관리자용 ----

    public record ProgramView(
            String programId,
            String name,
            String group,
            ProgramCategory category,
            String pagePath,
            String moduleId,
            List<String> actions,
            boolean superAdminOnly,
            boolean active,
            int sortOrder,
            boolean moduleConnected) {
    }

    public record PackageView(
            String packageId,
            String name,
            boolean active,
            boolean superAdmin,
            Map<String, PermissionView> permissions,
            DataScopeView dataScope,
            long accountCount) {
    }

    public record AccountView(
            String id,
            String username,
            String displayName,
            String packageId,
            String packageName,
            boolean active,
            boolean otpEnrolled) {
    }

    public record RegionView(String regionCode, String name, boolean active) {
    }

    public record DistrictInfo(String regionCode, String districtCode, String name, boolean active) {
    }

    public record ReferenceView(List<RegionView> regions, List<DistrictInfo> districts) {
    }

    public record ModuleView(String moduleId, String title, String frontendScript, List<String> defaultProgramIds,
            List<String> connectedProgramIds) {
    }
}
