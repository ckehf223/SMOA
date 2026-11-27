package com.smoa.module;

import java.util.Set;

/**
 * 업무 모듈 계약. 프로그램(최하위 메뉴)은 하나의 모듈이 처리한다(Program.moduleId).
 * 관련 프로그램끼리 한 모듈(예: analytics, records)을 공유할 수 있다.
 * 새 모듈을 붙이는 위치는 docs/MODULE_INTEGRATION_GUIDE.md 를 따른다.
 */
public interface ProgramModule {

    /** 모듈 키. frontend 의 모듈 등록(modules.js)과 같아야 한다. */
    String id();

    String title();

    /** 기본으로 이 모듈이 처리하는 프로그램 ID(시드 기준. 실제 연결은 Program.moduleId). */
    Set<String> defaultProgramIds();

    /** 업무 규칙·데이터 연결이 구현되어 실제로 동작하는 프로그램. 그 밖에는 501 MODULE_NOT_CONNECTED. */
    Set<String> connectedProgramIds();

    /** 공통 셸이 불러오는 정적 스크립트. */
    String frontendScript();

    /** Mapper XML namespace(문서·계약 검사용). 없으면 빈 문자열. */
    default String mapperNamespace() {
        return "";
    }
}
