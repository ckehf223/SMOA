package com.smoa.afterreport;

import java.util.List;
import java.util.function.Consumer;

import com.smoa.afterreport.AfterReportData.Draft;
import com.smoa.afterreport.AfterReportData.Filter;
import com.smoa.afterreport.AfterReportData.Row;

interface AfterReportRepository {
    record Results(List<Row> items, long total) {}

    Results find(Filter filter);

    void visit(Filter filter, Consumer<Row> visitor);

    /** Insert one participant row or atomically replace the organizer submission at the same key. */
    Row save(Draft draft);
}
