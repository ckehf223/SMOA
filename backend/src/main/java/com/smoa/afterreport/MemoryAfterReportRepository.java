package com.smoa.afterreport;

import java.time.Instant;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;

import com.smoa.afterreport.AfterReportData.Draft;
import com.smoa.afterreport.AfterReportData.Filter;
import com.smoa.afterreport.AfterReportData.ReportKey;
import com.smoa.afterreport.AfterReportData.Role;
import com.smoa.afterreport.AfterReportData.Row;

@Repository
@Profile("local-memory")
class MemoryAfterReportRepository implements AfterReportRepository {
    private static final Comparator<Row> ORDER = Comparator.<Row, java.time.LocalDate>comparing(r -> r.key().date())
            .reversed().thenComparing(r -> r.key().slot()).thenComparing(r -> r.key().role())
            .thenComparing(Comparator.comparingLong((Row r) -> Long.parseLong(r.id())).reversed());
    private final Map<String, Row> rows = new LinkedHashMap<>();
    private final Map<ReportKey, String> organizers = new LinkedHashMap<>();
    private long nextId = 1;

    @Override
    public synchronized Results find(Filter filter) {
        List<Row> matched = rows.values().stream().filter(row -> matches(row.key(), filter)).sorted(ORDER).toList();
        return new Results(matched.stream().skip(filter.offset()).limit(filter.size()).toList(), matched.size());
    }

    @Override
    public synchronized void visit(Filter filter, Consumer<Row> visitor) {
        rows.values().stream().filter(row -> matches(row.key(), filter)).forEach(visitor);
    }

    @Override
    public synchronized Row save(Draft draft) {
        ReportKey key = draft.key();
        String id = key.role() == Role.ORGANIZER
                ? organizers.computeIfAbsent(key, unused -> Long.toString(nextId++)) : Long.toString(nextId++);
        Row row = new Row(id, key, draft.payload(), Instant.now().toString());
        rows.put(id, row);
        return row;
    }

    private static boolean matches(ReportKey key, Filter filter) {
        return filter.districts().contains(key.district())
                && (filter.role() == null || key.role() == filter.role())
                && (filter.from() == null || !key.date().isBefore(filter.from()))
                && (filter.to() == null || !key.date().isAfter(filter.to()));
    }
}
