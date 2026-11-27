package com.smoa.web.dto;

import java.util.List;
import java.util.Map;
import java.util.Set;

import com.smoa.permission.ScopeType;
import com.smoa.program.ProgramAction;
import com.smoa.program.ProgramCategory;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * 요청 DTO 모음. 정의되지 않은 필드는 Jackson 이 거부(400)한다(허용 목록).
 * 계정 요청에는 role/permissions/dataScope 가 없고, 패키지 요청에는 superAdmin 이 없다: 보내면 400.
 */
public final class Requests {

    private Requests() {
    }

    public record PermissionRequest(Boolean access, Boolean read, Boolean write, Boolean export) {
    }

    public record DistrictRequest(
            @NotBlank @Size(max = 64) String regionCode,
            @NotBlank @Size(max = 64) String districtCode) {
    }

    public record DataScopeRequest(
            @NotNull ScopeType type,
            @Size(max = 500) List<@Valid @NotNull DistrictRequest> districts) {
    }

    // ---- 프로그램 ----

    public record RegisterProgramRequest(
            @NotBlank @Size(max = 64) String programId,
            @NotBlank @Size(max = 50) String name,
            @Size(max = 30) String group,
            ProgramCategory category,
            @NotBlank @Size(max = 100) String pagePath,
            @NotBlank @Size(max = 40) String moduleId,
            Set<ProgramAction> actions,
            Boolean superAdminOnly,
            Boolean active,
            Integer sortOrder) {
    }

    /** programId 는 URL 경로에만 있고 바꿀 수 없다. 모든 필드 선택. */
    public record UpdateProgramRequest(
            @Size(max = 50) String name,
            @Size(max = 30) String group,
            ProgramCategory category,
            @Size(max = 100) String pagePath,
            @Size(max = 40) String moduleId,
            Set<ProgramAction> actions,
            Boolean active,
            Integer sortOrder) {
    }

    // ---- 권한 패키지 ----

    public record CreatePackageRequest(
            @NotBlank @Size(max = 50) String name,
            Boolean active,
            @Size(max = 500) Map<@Size(max = 64) String, @Valid PermissionRequest> permissions,
            @Valid DataScopeRequest dataScope) {
    }

    /** 모든 필드 선택. permissions/dataScope 는 주어지면 통째로 교체한다. */
    public record UpdatePackageRequest(
            @Size(max = 50) String name,
            Boolean active,
            @Size(max = 500) Map<@Size(max = 64) String, @Valid PermissionRequest> permissions,
            @Valid DataScopeRequest dataScope) {
    }

    // ---- 계정 ----

    public record CreateAccountRequest(
            @NotBlank @Pattern(regexp = "[A-Za-z0-9._-]{3,32}", message = "로그인 ID 는 영문·숫자·._- 3~32자여야 합니다.") String username,
            @NotBlank @Size(max = 50) String displayName,
            @NotBlank @Size(max = 128) String password,
            @NotBlank @Size(max = 64) String packageId,
            Boolean active) {

        @Override
        public String toString() {
            return "CreateAccountRequest[username=" + username + ", packageId=" + packageId + "]";
        }
    }

    public record UpdateAccountRequest(
            @Size(max = 50) String displayName,
            Boolean active,
            @Size(max = 64) String packageId) {
    }

    public record ResetPasswordRequest(@NotBlank @Size(max = 128) String newPassword) {

        @Override
        public String toString() {
            return "ResetPasswordRequest[***]";
        }
    }
}
