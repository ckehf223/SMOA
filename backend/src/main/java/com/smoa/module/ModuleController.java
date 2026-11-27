package com.smoa.module;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.smoa.common.ApiException;
import com.smoa.program.Program;
import com.smoa.program.ProgramRepository;

/**
 * 프로그램별 모듈 상태 조회와 미연결 업무 데이터 경로. 접근 권한은 보안 필터가 {@code /api/programs/{programId}/**} 로 먼저 검사한다.
 * 데이터 연결이 없는 프로그램의 {@code /data/**} 는 200·빈 목록이 아니라 501 MODULE_NOT_CONNECTED 를 돌려준다.
 * 응답에는 Java 클래스·SQL·예외 같은 구현 세부를 담지 않는다.
 */
@RestController
@RequestMapping("/api/programs/{programId}")
public class ModuleController {

    public record ModuleStatus(String programId, String moduleId, String title, boolean connected, String state,
            String message) {
    }

    private final ProgramRepository programs;
    private final ModuleRegistry modules;

    public ModuleController(ProgramRepository programs, ModuleRegistry modules) {
        this.programs = programs;
        this.modules = modules;
    }

    @GetMapping("/module")
    public ModuleStatus status(@PathVariable String programId) {
        Program program = programs.findById(programId).filter(Program::active)
                .orElseThrow(() -> ApiException.notFound("프로그램을 찾을 수 없습니다."));
        ProgramModule module = modules.find(program.moduleId())
                .orElseThrow(() -> ApiException.notFound("프로그램 모듈을 찾을 수 없습니다."));
        boolean connected = module.connectedProgramIds().contains(programId);
        return new ModuleStatus(programId, module.id(), module.title(), connected, connected ? "CONNECTED" : "NOT_CONNECTED",
                connected ? "사용할 수 있습니다." : "데이터 연결 준비 중입니다.");
    }

    @RequestMapping("/data/**")
    public void notConnected(@PathVariable String programId) {
        Program program = programs.findById(programId).filter(Program::active)
                .orElseThrow(() -> ApiException.notFound("프로그램을 찾을 수 없습니다."));
        boolean connected = modules.find(program.moduleId()).map(m -> m.connectedProgramIds().contains(programId))
                .orElse(false);
        if (connected) {
            throw ApiException.notFound("요청한 자원을 찾을 수 없습니다.");
        }
        throw ApiException.notConnected("데이터 연결 준비 중입니다. 사용자 테이블 연결 후 사용할 수 있습니다.");
    }
}
