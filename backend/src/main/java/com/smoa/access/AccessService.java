package com.smoa.access;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.springframework.stereotype.Service;

import com.smoa.account.Account;
import com.smoa.common.ApiException;
import com.smoa.permission.ActionPermission;
import com.smoa.permission.DataScope;
import com.smoa.permission.PackageRepository;
import com.smoa.permission.PermissionPackage;
import com.smoa.program.Program;
import com.smoa.program.ProgramAction;
import com.smoa.program.ProgramRepository;

/**
 * 권한 판정의 단일 지점. 계정에 저장된 packageId 로 패키지를 읽고, 패키지의 프로그램 권한을 활성 프로그램에 대해서만 인정한다.
 * 총관리자 여부는 패키지 이름이 아니라 보호된 superAdmin 속성으로 판단한다.
 * 패키지·프로그램 변경은 이 서비스가 매 요청 다시 계산하므로 다음 요청부터 반영된다.
 */
@Service
public class AccessService {

    private final PackageRepository packages;
    private final ProgramRepository programs;

    public AccessService(PackageRepository packages, ProgramRepository programs) {
        this.packages = packages;
        this.programs = programs;
    }

    public AccessGrant resolve(Account account) {
        Optional<PermissionPackage> found = account.active() ? packages.findById(account.packageId()) : Optional.empty();
        if (found.isEmpty() || !found.get().active()) {
            PermissionPackage pkg = found.orElse(null);
            return new AccessGrant(account, account.packageId(), pkg == null ? "" : pkg.name(), false, false, Map.of(),
                    Map.of(), DataScope.none());
        }
        PermissionPackage pkg = found.get();
        Map<String, ActionPermission> effective = new LinkedHashMap<>();
        Map<String, Program> visible = new LinkedHashMap<>();
        for (Program program : programs.findAll()) {
            if (!program.active()) {
                continue;
            }
            ActionPermission permission;
            if (pkg.superAdmin()) {
                permission = ActionPermission.full(program);
            } else if (program.superAdminOnly()) {
                continue;
            } else {
                ActionPermission stored = pkg.permissions().get(program.programId());
                permission = stored == null ? ActionPermission.NONE : stored.normalizedFor(program);
            }
            if (permission.access()) {
                effective.put(program.programId(), permission);
                visible.put(program.programId(), program);
            }
        }
        DataScope scope = pkg.superAdmin() ? DataScope.all() : pkg.scope();
        return new AccessGrant(account, pkg.packageId(), pkg.name(), true, pkg.superAdmin(), effective, visible, scope);
    }

    /** 서비스 계층 이중 확인용. 거부 시 403. */
    public void require(AccessGrant grant, String programId, ProgramAction action) {
        if (!grant.canAll(programId, ProgramAction.ACCESS, ProgramAction.READ, action)) {
            throw ApiException.forbidden("FORBIDDEN", "이 기능에 대한 권한이 없습니다.");
        }
    }

    /** 접근 가능한 프로그램(메뉴). 정렬 순서(sortOrder, programId). */
    public List<Program> menu(AccessGrant grant) {
        return grant.programs().values().stream()
                .sorted(Comparator.comparingInt(Program::sortOrder).thenComparing(Program::programId)).toList();
    }
}
