package com.smoa.calling;

import java.text.NumberFormat;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import com.smoa.calling.CallingRecord.Round;
import com.smoa.calling.CallingRepository.Range;

final class CallingStatistics {
    record Total(int count, int successes, Double rate, int targets, int callerCount) {
    }

    record Group(String caller, Integer hour, String round, String roundLabel, int count, int successes, Double rate) {
    }

    record Threshold(int days, long count, Double rate) {
    }

    record Lag(int count, int missing, Double average, Double median, Long p80, List<Threshold> within) {
    }

    record Connected(String caller, String introducer) {
    }

    record Summary(Total totals, int missingTime, List<Group> byHour, List<Group> byCaller, List<Group> byRound,
            List<Group> byCallerHour, List<Group> byCallerRound, Lag lag, List<Connected> connected, String report) {
    }

    private record GroupKey(String caller, Integer hour, Round round) {
    }

    private static final class Counts {
        int total;
        int successes;

        void add(boolean success) {
            total++;
            if (success) successes++;
        }
    }

    private CallingStatistics() {
    }

    static Summary summarize(List<CallingRecord> rows, List<Round> rounds, Map<String, String> callers, Range range,
            boolean includeConnected) {
        Map<GroupKey, Counts> byHour = new HashMap<>();
        Map<GroupKey, Counts> byCaller = new HashMap<>();
        Map<GroupKey, Counts> byRound = new LinkedHashMap<>();
        Map<GroupKey, Counts> byCallerHour = new HashMap<>();
        Map<GroupKey, Counts> byCallerRound = new HashMap<>();
        Map<String, Long> firstSuccess = new HashMap<>();
        Set<String> targets = new HashSet<>();
        var connected = new ArrayList<Connected>();
        var total = new Counts();
        int missingTime = 0;
        rounds.forEach(round -> byRound.put(new GroupKey(null, null, round), new Counts()));
        for (var row : rows) {
            boolean success = "만픽".equals(row.outcome().result());
            total.add(success);
            targets.add(CallingAttempts.targetKey(row));
            String caller = callers.getOrDefault(CallingRules.callerKey(row.caller()), row.caller());
            if (success && includeConnected) connected.add(new Connected(caller, CallingRules.mask(row.subject().introducer())));
            count(byRound, null, null, row.round(), success);
            count(byCaller, caller, null, null, success);
            count(byCallerRound, caller, null, row.round(), success);
            if (row.time() == null) {
                missingTime++;
            } else {
                int hour = row.time().getHour();
                count(byHour, null, hour, null, success);
                count(byCallerHour, caller, hour, null, success);
            }
            if (success && row.subject().id() != null) {
                var found = row.subject().foundDate();
                long delay = found != null && !row.date().isBefore(found)
                        ? ChronoUnit.DAYS.between(found, row.date()) : Long.MAX_VALUE;
                firstSuccess.merge(row.subject().id(), delay, Math::min);
            }
        }
        Total totals = new Total(total.total, total.successes, rate(total.successes, total.total), targets.size(), byCaller.size());
        var roundGroups = groups(byRound);
        return new Summary(totals, missingTime, groups(byHour), groups(byCaller), roundGroups,
                groups(byCallerHour), groups(byCallerRound), lag(firstSuccess), connected, report(range, roundGroups, totals));
    }

    private static void count(Map<GroupKey, Counts> groups, String caller, Integer hour, Round round, boolean success) {
        groups.computeIfAbsent(new GroupKey(caller, hour, round), key -> new Counts()).add(success);
    }

    private static List<Group> groups(Map<GroupKey, Counts> counts) {
        return counts.entrySet().stream().sorted((left, right) -> compare(left.getKey(), right.getKey()))
                .map(e -> {
                    var key = e.getKey();
                    var value = e.getValue();
                    var round = key.round();
                    return new Group(key.caller(), key.hour(), round == null ? null : round.value(),
                            round == null ? null : round.label(), value.total, value.successes, rate(value.successes, value.total));
                }).toList();
    }

    private static int compare(GroupKey left, GroupKey right) {
        if (left.caller() != null && right.caller() != null) {
            int cmp = CallingRules.KOREAN.compare(left.caller(), right.caller());
            if (cmp != 0) return cmp;
        }
        if (left.hour() != null) return Integer.compare(left.hour(), right.hour());
        return left.round() == null ? 0 : CallingRules.ROUND_ORDER.compare(left.round(), right.round());
    }

    private static Double rate(long count, long total) {
        return total == 0 ? null : 100.0 * count / total;
    }

    private static Lag lag(Map<String, Long> first) {
        List<Long> days = first.values().stream().filter(d -> d != Long.MAX_VALUE).sorted().toList();
        int n = days.size();
        var within = List.of(0, 1, 3, 7, 14, 30).stream().map(limit -> {
            long count = days.stream().filter(day -> day <= limit).count();
            return new Threshold(limit, count, rate(count, n));
        }).toList();
        return new Lag(n, first.size() - n, n == 0 ? null : days.stream().mapToLong(Long::longValue).average().orElseThrow(),
                n == 0 ? null : (days.get((n - 1) / 2) + days.get(n / 2)) / 2.0,
                n == 0 ? null : days.get((int) Math.ceil(n * 0.8) - 1), within);
    }

    private static String report(Range range, List<Group> rounds, Total total) {
        String date = "전체 기간";
        if (range.from() != null && range.to() != null) {
            date = range.from().equals(range.to()) ? range.from().toString() : range.from() + " ~ " + range.to();
        } else if (range.from() != null) {
            date = range.from() + "부터";
        } else if (range.to() != null) {
            date = range.to() + "까지";
        }
        NumberFormat integer = NumberFormat.getIntegerInstance(Locale.KOREAN);
        List<String> lines = new ArrayList<>(List.of("< 콜링 결과 보고 >", "날짜: " + date, ""));
        for (Group round : rounds) {
            if (round.count() == 0) continue;
            String heading = round.roundLabel();
            if (!heading.endsWith("콜링")) heading += "콜링";
            lines.add("✔️" + heading + " " + integer.format(round.count()) + "건 중 " + integer.format(round.successes()) + "건 연결");
        }
        long percent = total.rate() == null ? 0 : Math.round(total.rate());
        lines.addAll(List.of("", "", "", "🔺 총 " + integer.format(total.count()) + "건 중 "
                + integer.format(total.successes()) + "건 연결 (" + percent + "%)"));
        return String.join("\n", lines);
    }
}
