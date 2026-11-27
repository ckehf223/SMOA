package com.smoa.program;

import java.util.EnumSet;
import java.util.Set;

/**
 * 프로그램(최하위 메뉴) 정의. programId 는 불변 고유 키이며 이름·순서·경로를 바꿔도 유지된다.
 * actions 에는 READ/WRITE/EXPORT 중 이 프로그램에서 의미 있는 동작만 들어 있다(ACCESS 는 항상 있음).
 * moduleId 는 처리 모듈(frontend 스크립트와 backend 모듈) 등록 키다.
 * superAdminOnly 이면 총관리자 시스템 패키지만 접근할 수 있다(일반 패키지에는 부여 불가).
 */
public record Program(
        String programId,
        String name,
        String group,
        ProgramCategory category,
        String pagePath,
        String moduleId,
        Set<ProgramAction> actions,
        boolean superAdminOnly,
        boolean active,
        int sortOrder) {

    public Program {
        actions = actions == null || actions.isEmpty() ? Set.of() : Set.copyOf(EnumSet.copyOf(actions));
    }

    public boolean supports(ProgramAction action) {
        return action == ProgramAction.ACCESS || actions.contains(action);
    }

    public Program withActive(boolean value) {
        return new Program(programId, name, group, category, pagePath, moduleId, actions, superAdminOnly, value, sortOrder);
    }
}
