package com.smoa.permission;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.springframework.stereotype.Component;

import com.smoa.common.ApiException;
import com.smoa.program.Program;
import com.smoa.program.ProgramAction;
import com.smoa.program.ProgramRepository;
import com.smoa.reference.ReferenceRepository;

/** 패키지 생성·수정 요청의 프로그램 권한·구역 범위 검증. 규칙 위반은 400. */
@Component
public class PermissionPolicy {

    public static final int MAX_DISTRICTS = 500;

    private final ProgramRepository programs;
    private final ReferenceRepository reference;

    public PermissionPolicy(ProgramRepository programs, ReferenceRepository reference) {
        this.programs = programs;
        this.reference = reference;
    }

    /** 아무 동작도 없는 항목은 저장하지 않는다(= 기본 거부). */
    public Map<String, ActionPermission> validate(Map<String, ActionPermission> requested) {
        Map<String, ActionPermission> result = new LinkedHashMap<>();
        for (Map.Entry<String, ActionPermission> e : requested.entrySet()) {
            Program program = programs.findById(e.getKey()).orElseThrow(() -> ApiException
                    .badRequest("UNKNOWN_PROGRAM", "등록되지 않은 프로그램 ID 입니다: " + safe(e.getKey())));
            ActionPermission p = e.getValue() == null ? ActionPermission.NONE : e.getValue();
            if (p.isNone()) {
                continue;
            }
            if (!p.access()) {
                throw ApiException.badRequest("INVALID_PERMISSION",
                        program.programId() + ": access=false 이면 다른 동작을 부여할 수 없습니다.");
            }
            if (!p.read() && (p.write() || p.export())) {
                throw ApiException.badRequest("INVALID_PERMISSION",
                        program.programId() + ": read=false 이면 write/export 를 부여할 수 없습니다.");
            }
            for (ProgramAction action : new ProgramAction[] {ProgramAction.READ, ProgramAction.WRITE,
                    ProgramAction.EXPORT}) {
                if (p.allows(action) && !program.supports(action)) {
                    throw ApiException.badRequest("ACTION_NOT_ALLOWED",
                            program.programId() + " 프로그램에는 " + action.json() + " 동작이 없습니다.");
                }
            }
            if (program.superAdminOnly()) {
                throw ApiException.badRequest("SUPER_ADMIN_ONLY",
                        program.programId() + " 프로그램은 총관리자 시스템 패키지에만 허용됩니다.");
            }
            result.put(program.programId(), p);
        }
        return result;
    }

    /** ORG 는 존재하고 활성인 (지역+구역) 만. 배정이 0개인 ORG 는 허용하지만 아무 자료도 보이지 않는다. */
    public DataScope validateScope(ScopeType type, Collection<DistrictKey> districts) {
        if (type == null) {
            throw ApiException.badRequest("INVALID_SCOPE", "데이터 범위 type 이 필요합니다.");
        }
        Collection<DistrictKey> keys = districts == null ? List.of() : districts;
        if (type == ScopeType.ALL) {
            if (!keys.isEmpty()) {
                throw ApiException.badRequest("INVALID_SCOPE", "ALL 범위에는 districts 를 지정할 수 없습니다.");
            }
            return DataScope.all();
        }
        if (keys.size() > MAX_DISTRICTS) {
            throw ApiException.badRequest("INVALID_SCOPE", "구역은 최대 " + MAX_DISTRICTS + "개까지 지정할 수 있습니다.");
        }
        Set<DistrictKey> unique = new LinkedHashSet<>();
        for (DistrictKey key : keys) {
            if (key == null || !reference.isActive(key)) {
                throw ApiException.badRequest("UNKNOWN_DISTRICT", "존재하지 않거나 비활성인 지역·구역입니다.");
            }
            unique.add(key);
        }
        return DataScope.org(unique);
    }

    private static String safe(String key) {
        if (key == null) {
            return "";
        }
        return key.length() > 64 ? key.substring(0, 64) : key;
    }
}
