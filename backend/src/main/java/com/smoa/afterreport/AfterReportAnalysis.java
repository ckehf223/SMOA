package com.smoa.afterreport;

import java.time.LocalDate;
import java.time.YearMonth;
import java.util.Comparator;
import java.util.List;
import java.util.NavigableMap;
import java.util.TreeMap;
import java.util.stream.IntStream;

import com.smoa.afterreport.AfterReportData.Analysis;
import com.smoa.afterreport.AfterReportData.ChecklistTotals;
import com.smoa.afterreport.AfterReportData.PeriodTotals;
import com.smoa.afterreport.AfterReportData.Role;
import com.smoa.afterreport.AfterReportData.Row;

final class AfterReportAnalysis {
    private final NavigableMap<LocalDate, Totals> daily = new TreeMap<>(Comparator.reverseOrder());
    private final NavigableMap<YearMonth, Totals> monthly = new TreeMap<>(Comparator.reverseOrder());
    private final List<String> checklistLabels;
    private final long[][] checklistScores;

    AfterReportAnalysis(List<String> checklistLabels) {
        this.checklistLabels = checklistLabels;
        this.checklistScores = new long[checklistLabels.size()][3];
    }

    void add(Row row) {
        LocalDate date = row.key().date();
        daily.computeIfAbsent(date, unused -> new Totals()).add(row);
        monthly.computeIfAbsent(YearMonth.from(date), unused -> new Totals()).add(row);
        if (row.key().role() == Role.PARTICIPANT) {
            List<Integer> scores = row.payload().participantScores();
            for (int index = 0; index < checklistScores.length; index++) {
                int score = scores.get(index);
                checklistScores[index][score - 1]++;
            }
        }
    }

    Analysis result() {
        return new Analysis(
                daily.entrySet().stream().map(entry -> entry.getValue().period(entry.getKey().toString())).toList(),
                monthly.entrySet().stream().map(entry -> entry.getValue().period(entry.getKey().toString())).toList(),
                IntStream.range(0, checklistLabels.size()).mapToObj(this::checklist).toList());
    }

    private ChecklistTotals checklist(int index) {
        long[] scores = checklistScores[index];
        long total = scores[0] + scores[1] + scores[2];
        Double rate = total == 0 ? null : Math.round(1000.0 * scores[2] / total) / 10.0;
        return new ChecklistTotals(checklistLabels.get(index), scores[0], scores[1], scores[2], total, rate);
    }

    private static final class Totals {
        private long organizerReports;
        private long participantReports;
        private long headcount;
        private long organizerFindings;
        private long participantFindings;

        void add(Row row) {
            if (row.key().role() == Role.ORGANIZER) {
                organizerReports++;
                headcount += row.payload().headcount();
                organizerFindings += row.payload().findings();
            } else {
                participantReports++;
                participantFindings += row.payload().findings();
            }
        }

        PeriodTotals period(String period) {
            return new PeriodTotals(period, organizerReports, participantReports, headcount, organizerFindings,
                    participantFindings);
        }
    }
}
