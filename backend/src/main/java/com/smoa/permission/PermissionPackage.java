package com.smoa.permission;

import java.util.Map;
import java.util.Objects;

/**
 * 권한 패키지. packageId 는 불변, 이름은 관리자가 정하는 자유 문자열(1구역장/콜링팀장 등)이며 권한과 무관하다.
 * superAdmin 은 보호된 시스템 패키지 속성이다: 부트스트랩만 만들 수 있고 API 로 바꿀 수 없다.
 * superAdmin 패키지는 permissions 를 쓰지 않고 활성 프로그램 전체·범위 ALL 로 평가된다.
 */
public record PermissionPackage(
        String packageId,
        String name,
        boolean active,
        boolean superAdmin,
        Map<String, ActionPermission> permissions,
        DataScope scope) {

    public PermissionPackage {
        Objects.requireNonNull(packageId, "packageId");
        Objects.requireNonNull(name, "name");
        Objects.requireNonNull(scope, "scope");
        permissions = permissions == null ? Map.of() : Map.copyOf(permissions);
    }

    public PermissionPackage withName(String value) {
        return new PermissionPackage(packageId, value, active, superAdmin, permissions, scope);
    }

    public PermissionPackage withActive(boolean value) {
        return new PermissionPackage(packageId, name, value, superAdmin, permissions, scope);
    }

    public PermissionPackage withPermissions(Map<String, ActionPermission> value) {
        return new PermissionPackage(packageId, name, active, superAdmin, value, scope);
    }

    public PermissionPackage withScope(DataScope value) {
        return new PermissionPackage(packageId, name, active, superAdmin, permissions, value);
    }
}
