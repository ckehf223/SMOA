package com.smoa.access;

import java.util.Map;

import com.smoa.account.Account;
import com.smoa.permission.ActionPermission;
import com.smoa.permission.DataScope;
import com.smoa.program.Program;
import com.smoa.program.ProgramAction;

/**
 * 요청마다 account → 활성 패키지 → 활성 프로그램 순서로 다시 계산한 유효 권한 스냅샷.
 * permissions 에는 활성 프로그램 중 access 가 있는 것만 들어 있다(이미 프로그램 지원 동작으로 정규화됨).
 * 패키지가 없거나 비활성이면 permissions 는 비고 범위는 배정 0개(거부)다.
 */
public record AccessGrant(
        Account account,
        String packageId,
        String packageName,
        boolean packageActive,
        boolean superAdmin,
        Map<String, ActionPermission> permissions,
        Map<String, Program> programs,
        DataScope scope) {

    public AccessGrant {
        permissions = Map.copyOf(permissions);
        programs = Map.copyOf(programs);
    }

    public boolean can(String programId, ProgramAction action) {
        ActionPermission p = permissions.get(programId);
        return p != null && p.allows(action);
    }

    public boolean canAll(String programId, ProgramAction... actions) {
        for (ProgramAction action : actions) {
            if (!can(programId, action)) {
                return false;
            }
        }
        return true;
    }

    public String accountId() {
        return account.id();
    }
}
