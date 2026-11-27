package com.smoa.program.memory;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.springframework.context.annotation.Profile;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Repository;

import com.smoa.program.Program;
import com.smoa.program.ProgramRepository;

/** local-memory 전용 가상 저장소. 서버를 종료하면 사라진다. */
@Repository
@Profile("local-memory")
public class MemoryProgramRepository implements ProgramRepository {

    private final Map<String, Program> byId = new LinkedHashMap<>();

    @Override
    public synchronized Optional<Program> findById(String programId) {
        return Optional.ofNullable(byId.get(programId));
    }

    @Override
    public synchronized Optional<Program> findByPagePath(String pagePath) {
        return byId.values().stream().filter(p -> p.pagePath().equals(pagePath)).findFirst();
    }

    @Override
    public synchronized List<Program> findAll() {
        List<Program> all = new ArrayList<>(byId.values());
        all.sort(Comparator.comparingInt(Program::sortOrder).thenComparing(Program::programId));
        return all;
    }

    @Override
    public synchronized void insert(Program program) {
        if (byId.containsKey(program.programId()) || findByPagePath(program.pagePath()).isPresent()) {
            throw new DuplicateKeyException("duplicate program");
        }
        byId.put(program.programId(), program);
    }

    @Override
    public synchronized void update(Program program) {
        if (!byId.containsKey(program.programId())) {
            throw new IllegalStateException("존재하지 않는 프로그램입니다.");
        }
        for (Program other : byId.values()) {
            if (!other.programId().equals(program.programId()) && other.pagePath().equals(program.pagePath())) {
                throw new DuplicateKeyException("duplicate page path");
            }
        }
        byId.put(program.programId(), program);
    }
}
