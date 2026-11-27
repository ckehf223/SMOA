package com.smoa.calling;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;

import com.smoa.permission.DataScope;

@Repository
@Profile("local-memory")
class MemoryCallingRepository implements CallingRepository {
    private final Map<String, CallingRecord> rows = new LinkedHashMap<>();
    private long nextId = 1;

    @Override
    public synchronized List<CallingRecord> select(DataScope scope, Range range, int limit) {
        return rows.values().stream().filter(row -> scope.covers(row.subject().district()))
                .filter(row -> CallingAttempts.inRange(row, range))
                .sorted(CallingAttempts.NEWEST).limit(limit).toList();
    }

    @Override
    public synchronized List<Option> options(DataScope scope) {
        return rows.values().stream().filter(row -> scope.covers(row.subject().district()))
                .map(row -> new Option(row.caller(), row.round())).distinct().toList();
    }

    @Override
    public synchronized Optional<CallingRecord> find(DataScope scope, String id) {
        return Optional.ofNullable(rows.get(id)).filter(row -> scope.covers(row.subject().district()));
    }

    @Override
    public void lock() {
    }

    @Override
    public synchronized <T> T serialized(Supplier<T> work) {
        return work.get();
    }

    @Override
    public synchronized String insert(CallingRecord record) {
        String id = Long.toString(nextId++);
        rows.put(id, record.identity(id, 1));
        return id;
    }

    @Override
    public synchronized boolean update(DataScope scope, CallingRecord record, boolean replaceSubject) {
        var before = find(scope, record.id()).orElse(null);
        if (before == null || before.rowVersion() != record.rowVersion()) return false;
        rows.put(record.id(), record.identity(record.id(), record.rowVersion() + 1));
        return true;
    }

    @Override
    public synchronized boolean delete(DataScope scope, CallingRecord record) {
        var before = find(scope, record.id()).orElse(null);
        if (before == null || before.rowVersion() != record.rowVersion()) return false;
        rows.remove(record.id());
        return true;
    }
}
