package com.smoa.afterreport;

import java.time.LocalDate;
import java.util.List;

import com.fasterxml.jackson.databind.JsonNode;
import com.smoa.permission.DistrictKey;

public final class AfterReportData {
    private AfterReportData() {}

    public enum Role { ORGANIZER, PARTICIPANT }

    public record TimeRange(String start, String end) {}

    public record Submission(String date, String slot, String regionCode, String districtCode, String location,
            String name, List<TimeRange> timeRanges, JsonNode findings, JsonNode headcount, JsonNode personalFindings,
            String potionName, List<JsonNode> organizerChecklist, String notes, List<JsonNode> participantScores,
            String remarks) {
        @Override
        public String toString() {
            return "AfterReportSubmission";
        }
    }

    record Payload(String location, String name, List<TimeRange> timeRanges, int findings, Integer headcount,
            Integer personalFindings, String potionName, List<Boolean> organizerChecklist, String notes,
            List<Integer> participantScores, String remarks) {
        @Override
        public String toString() {
            return "AfterReportPayload";
        }
    }

    record ReportKey(LocalDate date, String slot, DistrictKey district, Role role) {}
    record Draft(ReportKey key, Payload payload, String accountId) {}
    record Row(String id, ReportKey key, Payload payload, String updatedAt) {}

    public record Report(String id, Role role, LocalDate date, String slot, String regionCode, String districtCode,
            String location, String name, List<TimeRange> timeRanges, int findings, Integer headcount,
            Integer personalFindings, String potionName, List<Boolean> organizerChecklist, String notes,
            List<Integer> participantScores, String remarks, String updatedAt) {
        static Report from(Row row) {
            ReportKey key = row.key();
            Payload p = row.payload();
            return new Report(row.id(), key.role(), key.date(), key.slot(), key.district().regionCode(),
                    key.district().districtCode(), p.location(), p.name(), p.timeRanges(), p.findings(), p.headcount(),
                    p.personalFindings(), p.potionName(), p.organizerChecklist(), p.notes(), p.participantScores(),
                    p.remarks(), row.updatedAt());
        }

        @Override
        public String toString() {
            return "AfterReport[id=" + id + "]";
        }
    }

    public record DistrictOption(String regionCode, String districtCode, String label) {}
    public record Options(List<DistrictOption> districts, List<String> slots, List<String> locations,
            List<String> organizerChecks, List<String> participantChecks) {}

    public record Page(List<Report> items, long total, int page, int size) {}

    public record Analysis(List<PeriodTotals> daily, List<PeriodTotals> monthly,
            List<ChecklistTotals> checklist) {}

    public record PeriodTotals(String period, long organizerReports, long participantReports, long headcount,
            long organizerFindings, long participantFindings) {}

    public record ChecklistTotals(String label, long score1, long score2, long score3, long total,
            Double score3Rate) {}

    record Filter(LocalDate from, LocalDate to, List<DistrictKey> districts, Role role, int page, int size) {
        public long offset() {
            return ((long) page - 1) * size;
        }
    }
}
