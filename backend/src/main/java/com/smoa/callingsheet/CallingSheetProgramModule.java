package com.smoa.callingsheet;

import java.util.Set;

import org.springframework.stereotype.Component;

import com.smoa.module.ProgramModule;

/**
 * 콜링시트 업무 모듈 등록. {@code ModulesConfig} 를 고치지 않고 컴포넌트 스캔으로 ModuleRegistry 에 들어간다(ID 중복 시 기동 실패).
 * 기존 callingManage(콜링 기록)·callingStats(통계)와 별개 모듈이다.
 * connectedProgramIds 에 callingSheet 가 있으므로 ModuleController 상태 조회가 CONNECTED 로 답한다.
 */
@Component
public class CallingSheetProgramModule implements ProgramModule {

    public static final String MODULE_ID = "callingSheet";

    @Override
    public String id() {
        return MODULE_ID;
    }

    @Override
    public String title() {
        return "콜링시트";
    }

    @Override
    public Set<String> defaultProgramIds() {
        return Set.of(CallingSheetService.PROGRAM_ID);
    }

    @Override
    public Set<String> connectedProgramIds() {
        return Set.of(CallingSheetService.PROGRAM_ID);
    }

    @Override
    public String frontendScript() {
        return "/assets/modules/calling-sheet.js";
    }

    @Override
    public String mapperNamespace() {
        return "com.smoa.callingsheet.persistence.CallingSheetMapper";
    }
}
