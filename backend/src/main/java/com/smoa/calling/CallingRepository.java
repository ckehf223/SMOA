package com.smoa.calling;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.function.Supplier;

import com.smoa.calling.CallingRecord.Round;
import com.smoa.permission.DataScope;

interface CallingRepository {
    record Range(LocalDate from, LocalDate to, String regionCode, String districtCode) {
    }

    record Option(String caller, Round round) {
    }

    List<CallingRecord> select(DataScope scope, Range range, int limit);
    List<Option> options(DataScope scope);
    Optional<CallingRecord> find(DataScope scope, String id);
    void lock();
    String insert(CallingRecord record);
    boolean update(DataScope scope, CallingRecord record, boolean replaceSubject);
    boolean delete(DataScope scope, CallingRecord record);

    default int weekStart() {
        return 0;
    }

    /** MariaDB serializes with a transaction-held lock. Memory uses the repository's monitor. */
    default <T> T serialized(Supplier<T> work) {
        return work.get();
    }
}
