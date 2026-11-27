package com.smoa.program.persistence;

import java.util.EnumSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;

import com.smoa.audit.AuditStamp;
import com.smoa.module.ModuleRegistry;
import com.smoa.program.Program;
import com.smoa.program.ProgramAction;
import com.smoa.program.ProgramCategory;
import com.smoa.program.ProgramRepository;

/**
 * local/prod 저장소 어댑터(PGMMSTR). SQL 은 mapper XML 에 있으며 이 클래스는 행 ↔ 도메인 변환과 감사 값 채우기만 한다.
 * MODULE_ID/CATEGORY_CODE 가 NULL 인 기존 메뉴(원본 25개)는 모듈 기본 카탈로그(ProgramModule.defaultProgramIds)로 해석한다.
 */
@Repository
@Profile({"local", "prod"})
public class MyBatisProgramRepository implements ProgramRepository {

    /** 관리 성격(설정·코드) 기본 프로그램. 이 목록과 총관리자 전용이 ADMIN 분류의 기본값이다. */
    static final Set<String> DEFAULT_ADMIN_PROGRAMS = Set.of("codes", "settings", "users", "permissions", "programs");

    private final ProgramMapper mapper;
    private final ModuleRegistry modules;

    public MyBatisProgramRepository(ProgramMapper mapper, ModuleRegistry modules) {
        this.mapper = mapper;
        this.modules = modules;
    }

    @Override
    public Optional<Program> findById(String programId) {
        return Optional.ofNullable(mapper.selectProgramById(programId)).map(this::toProgram);
    }

    @Override
    public Optional<Program> findByPagePath(String pagePath) {
        return Optional.ofNullable(mapper.selectProgramByPagePath(pagePath)).map(this::toProgram);
    }

    @Override
    public List<Program> findAll() {
        return mapper.selectAllPrograms().stream().map(this::toProgram).toList();
    }

    @Override
    public void insert(Program program) {
        mapper.insertProgram(toRow(program));
    }

    @Override
    public void update(Program program) {
        int updated = mapper.updateProgram(toRow(program));
        if (updated != 1) {
            throw new IllegalStateException("프로그램 수정 결과가 1건이 아닙니다: " + updated);
        }
    }

    static ProgramRow toRow(Program p) {
        ProgramRow row = new ProgramRow();
        row.programId = p.programId();
        row.name = p.name();
        row.groupName = p.group();
        row.category = p.category().name();
        row.pagePath = p.pagePath();
        row.moduleId = p.moduleId();
        row.readUse = p.actions().contains(ProgramAction.READ);
        row.writeUse = p.actions().contains(ProgramAction.WRITE);
        row.exportUse = p.actions().contains(ProgramAction.EXPORT);
        row.superAdminOnly = p.superAdminOnly();
        row.active = p.active();
        row.sortOrder = p.sortOrder();
        AuditStamp stamp = AuditStamp.current();
        row.sysUserId = stamp.userId();
        row.sysIp = stamp.ip();
        row.sysAt = stamp.utcNow();
        return row;
    }

    Program toProgram(ProgramRow row) {
        Set<ProgramAction> actions = EnumSet.noneOf(ProgramAction.class);
        if (Boolean.TRUE.equals(row.readUse)) {
            actions.add(ProgramAction.READ);
        }
        if (Boolean.TRUE.equals(row.writeUse)) {
            actions.add(ProgramAction.WRITE);
        }
        if (Boolean.TRUE.equals(row.exportUse)) {
            actions.add(ProgramAction.EXPORT);
        }
        boolean superOnly = Boolean.TRUE.equals(row.superAdminOnly);
        String moduleId = row.moduleId != null && !row.moduleId.isBlank() ? row.moduleId
                : modules.moduleOfDefaultProgram(row.programId).orElse(null);
        ProgramCategory category;
        if (row.category != null && !row.category.isBlank()) {
            category = ProgramCategory.valueOf(row.category.strip().toUpperCase(java.util.Locale.ROOT));
        } else {
            category = superOnly || DEFAULT_ADMIN_PROGRAMS.contains(row.programId) ? ProgramCategory.ADMIN
                    : ProgramCategory.BUSINESS;
        }
        return new Program(row.programId, row.name, row.groupName == null ? "" : row.groupName, category, row.pagePath,
                moduleId, actions, superOnly, Boolean.TRUE.equals(row.active),
                row.sortOrder == null ? 1000 : row.sortOrder);
    }
}
