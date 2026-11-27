package com.smoa.program;

import java.util.List;
import java.util.Optional;

/**
 * 프로그램 정보 저장소 계약. local-memory 는 {@code MemoryProgramRepository}, local/prod 는 {@code MyBatisProgramRepository}.
 */
public interface ProgramRepository {

    Optional<Program> findById(String programId);

    Optional<Program> findByPagePath(String pagePath);

    /** sortOrder, programId 오름차순. 비활성 포함. */
    List<Program> findAll();

    /** 같은 programId 또는 pagePath 가 있으면 {@code DuplicateKeyException}. */
    void insert(Program program);

    /** programId 기준 전체 교체(이름·그룹·경로·모듈·동작·활성·순서). */
    void update(Program program);
}
