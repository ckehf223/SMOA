package com.smoa.module;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.springframework.stereotype.Component;

/** 등록된 업무 모듈 목록. 프로그램 등록은 여기에 있는 moduleId 만 허용한다. */
@Component
public class ModuleRegistry {

    private final Map<String, ProgramModule> byId = new LinkedHashMap<>();

    public ModuleRegistry(List<ProgramModule> modules) {
        for (ProgramModule module : modules.stream().sorted(Comparator.comparing(ProgramModule::id)).toList()) {
            if (byId.putIfAbsent(module.id(), module) != null) {
                throw new IllegalStateException("모듈 ID 가 중복됩니다: " + module.id());
            }
        }
    }

    public Optional<ProgramModule> find(String id) {
        return Optional.ofNullable(id == null ? null : byId.get(id));
    }

    /** 프로그램 ID 를 기본 처리 모듈(ProgramModule.defaultProgramIds)로 해석한다. MODULE_ID 가 비어 있는 기존 메뉴용. */
    public Optional<String> moduleOfDefaultProgram(String programId) {
        return byId.values().stream().filter(m -> m.defaultProgramIds().contains(programId)).map(ProgramModule::id)
                .findFirst();
    }

    public List<ProgramModule> all() {
        return List.copyOf(byId.values());
    }
}
