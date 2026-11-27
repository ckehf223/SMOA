package com.smoa.calling;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.smoa.common.ApiException;

final class CallingReportParser {
    private static final String SHEET = "콜링 일보";
    private static final Pattern TITLE = Pattern.compile("^(?:☎\\uFE0F?\\s*)?콜링\\s*(?:배분|일보)(?:\\s*☎\\uFE0F?)?$");
    private static final Pattern DATE_LINE = Pattern.compile("^(?:콜링\\s*)?날짜\\s*[:：]\\s*(.*)$");
    private static final Pattern DATE = Pattern.compile("^(?:(\\d{4})[-./]\\s*)?(\\d{1,2})\\s*[-./]\\s*(\\d{1,2})(?:\\s*\\([월화수목금토일](?:요일)?\\))?$");
    private static final Pattern DISTRICT = Pattern.compile("^(\\d+)\\s*구역(?:\\s*\\([^)]*\\))?$");
    private static final Pattern CALLER = Pattern.compile("^콜링자\\s*[:：]\\s*(.*)$");
    private static final Pattern CALLER_SUMMARY = Pattern.compile("^([^/／]+)[/／]([^/／]*)$");
    private static final Pattern COUNT = Pattern.compile("^(?:([\\d,]+)건?|[-–—?])$");
    private static final Pattern DETAIL = Pattern.compile("^(콜링자/)?인도자/대상자(?:명)?/(?:시간대|(?:콜링)?시간)/(?:콜링)?결과(?:/특이사항)?/?$");
    private static final Pattern MARKER = Pattern.compile("^(?:✅|☑\\uFE0F?|✔\\uFE0F?|🔶|🔷)\\s*");
    private static final Pattern NAMED_ROUND = Pattern.compile("^(?:회차|차수|구분)\\s*[:：]\\s*(.+)$");

    private record Line(int number, String heading, String detail) {
    }

    private record CallerTotal(String name, Integer expected) {
    }

    private CallingReportParser() {
    }

    static CallingImportParser.Parsed parse(String raw, String fallbackDate, String year, String baseCaller) {
        String text = CallingRules.text(raw, 500_000, "콜링 일보", true);
        String defaultCaller = CallingRules.text(baseCaller, 100, "기본 콜링자", false);
        LocalDate fallback = CallingRules.date(fallbackDate, false);
        String defaultYear = CallingRules.text(year, 4, "일보 연도", false);
        if (!defaultYear.isEmpty() && !defaultYear.matches("[1-9]\\d{3}")) throw CallingRules.invalid("일보 연도는 네 자리 숫자로 입력해 주세요.");
        if (defaultYear.isEmpty() && fallback != null) defaultYear = Integer.toString(fallback.getYear());
        var collected = new CallingImportParser.Collected();
        var warnings = new ArrayList<String>();
        Map<String, CallerTotal> reported = new LinkedHashMap<>();
        Map<String, Integer> counted = new LinkedHashMap<>();
        var lines = lines(text);
        LocalDate date = fallback;
        String round = "", district = "", explicit = "";
        boolean summary = false, footer = false, includesCaller = false;
        for (int index = 0; index < lines.size(); index++) {
            var line = lines.get(index);
            String value = line.heading();
            Matcher dateMatch = DATE_LINE.matcher(value);
            boolean newDate = dateMatch.matches();
            if (newDate || TITLE.matcher(value).matches() && (footer || !district.isEmpty())) {
                compareCounts(reported, counted, warnings);
                reported.clear();
                counted.clear();
                round = district = explicit = "";
                summary = footer = includesCaller = false;
                if (newDate) {
                    date = null;
                    try { date = date(dateMatch.group(1), defaultYear); }
                    catch (ApiException e) { collected.issue(SHEET, line.number(), e.getMessage()); }
                    continue;
                }
                if (fallback != null) date = fallback;
            }
            if (TITLE.matcher(value).matches()) continue;
            if (value.matches("(?i)^(?:ex|예시?)\\s*[):：].*") || value.matches("^결과의\\s*지정된\\s*값.*")) footer = true;
            if (footer) continue;
            String compact = CallingRules.searchKey(value).replace('／', '/');
            if (compact.matches("콜링자/(?:건수|콜링건수)")) {
                summary = true;
                continue;
            }
            var caller = CALLER.matcher(value);
            if (caller.matches()) {
                try { explicit = CallingRules.text(caller.group(1), 100, "콜링자", true); }
                catch (ApiException e) { collected.issue(SHEET, line.number(), e.getMessage()); }
                summary = false;
                continue;
            }
            String nextDistrict = district(value);
            if (nextDistrict != null) {
                district = nextDistrict;
                summary = false;
                continue;
            }
            boolean followedByDistrict = round.isEmpty() && index + 1 < lines.size() && district(lines.get(index + 1).heading()) != null;
            String nextRound = round(value, followedByDistrict);
            if (nextRound != null) {
                try {
                    CallingRules.parseRound(nextRound, false);
                    round = nextRound;
                } catch (ApiException e) {
                    round = "";
                    collected.issue(SHEET, line.number(), e.getMessage());
                }
                district = "";
                summary = false;
                continue;
            }
            var detailHeader = DETAIL.matcher(compact);
            if (detailHeader.matches()) {
                includesCaller = detailHeader.group(1) != null;
                summary = false;
                continue;
            }
            var declared = CALLER_SUMMARY.matcher(value);
            boolean summaryMatch = declared.matches();
            if (summary || round.isEmpty() && district.isEmpty() && summaryMatch && COUNT.matcher(CallingRules.searchKey(declared.group(2))).matches()) {
                try {
                    if (!summaryMatch) throw CallingRules.invalid("‘콜링자/건수’ 아래에는 ‘이름/건수’ 형식으로 입력해 주세요.");
                    String name = CallingRules.text(declared.group(1), 100, "콜링자", true);
                    var count = COUNT.matcher(CallingRules.searchKey(declared.group(2)));
                    Integer expected = null;
                    if (count.matches() && count.group(1) != null) expected = Integer.valueOf(count.group(1).replace(",", ""));
                    reported.put(CallingRules.searchKey(name), new CallerTotal(name, expected));
                } catch (ApiException | NumberFormatException e) {
                    collected.issue(SHEET, line.number(), "콜링자와 건수 표기를 확인해 주세요.");
                }
                continue;
            }
            collected.total++;
            if (collected.total > CallingImportParser.MAX_ROWS) throw CallingRules.invalid("한 번에 가져올 수 있는 콜링 기록은 2,000행입니다.");
            try {
                if (date == null) throw CallingRules.invalid("콜링 날짜를 선택하거나 상세 행 앞에 일보 날짜를 입력해 주세요.");
                if (round.isEmpty()) throw CallingRules.invalid("상세 행 앞에 콜링 회차 제목을 입력해 주세요.");
                if (district.isEmpty()) throw CallingRules.invalid("상세 행 앞에 ‘- 1구역’처럼 구역을 입력해 주세요.");
                int offset = includesCaller ? 1 : 0;
                String[] fields = line.detail().split("[/／]", offset + 5);
                if (fields.length < offset + 4) throw CallingRules.invalid("인도자/대상자/시간대/결과/특이사항 순서와 / 구분자를 확인해 주세요.");
                String name = includesCaller ? optional(fields[0]) : "";
                if (name.isEmpty()) name = explicit;
                if (name.isEmpty() && reported.size() == 1) name = reported.values().iterator().next().name();
                if (name.isEmpty()) name = defaultCaller;
                if (name.isEmpty()) throw CallingRules.invalid("‘콜링자: 이름’을 입력하거나 기본 콜링자를 지정해 주세요.");
                String target = CallingRules.text(optional(fields[offset + 1]), 100, "대상자명", true);
                String result = CallingRules.text(optional(fields[offset + 3]), 100, "콜링 결과", true);
                String notes = fields.length > offset + 4 ? fields[offset + 4].strip() : "";
                collected.rows.add(new CallingImportParser.Input(SHEET, line.number(), target, optional(fields[offset]),
                        district, "", date, CallingImportParser.time(optional(fields[offset + 2])), round, result, name, notes));
                counted.merge(CallingRules.searchKey(name), 1, Integer::sum);
            } catch (ApiException e) {
                collected.issue(SHEET, line.number(), e.getMessage());
            }
        }
        compareCounts(reported, counted, warnings);
        return collected.result(false, true, warnings);
    }

    private static void compareCounts(Map<String, CallerTotal> reported, Map<String, Integer> counted, List<String> warnings) {
        reported.forEach((key, total) -> {
            int read = counted.getOrDefault(key, 0);
            if (warnings.size() < 50 && total.expected() != null && total.expected() != read) {
                warnings.add(CallingRules.mask(total.name()) + " 콜링자 표기 " + total.expected() + "건, 상세 " + read + "건");
            }
        });
    }

    private static String optional(String raw) {
        String value = raw.strip();
        return value.matches("[-–—]") ? "" : value;
    }

    private static List<Line> lines(String text) {
        String[] raw = text.split("\\r\\n?|\\n");
        boolean markdown = java.util.Arrays.stream(raw).anyMatch(s -> s.strip().matches("^\\\\(?:$|[-*]\\s.*)"));
        List<Line> lines = new ArrayList<>();
        for (int i = 0; i < raw.length; i++) {
            String value = raw[i].strip();
            String heading = clean(value.replaceFirst("\\\\$", ""));
            if (!heading.isEmpty()) lines.add(new Line(i + 1, heading, clean(markdown ? value.replaceFirst("(?<!\\b[a-zA-Z]:)\\\\$", "") : value)));
        }
        return lines;
    }

    private static String clean(String value) {
        return value.replaceFirst("^\\\\(?=[-*])", "").replaceFirst("^[-*▪▫•]\\s+(?!\\s*[/／])", "")
                .replaceFirst("^\\*\\*(.*)\\*\\*$", "$1").strip();
    }

    private static String district(String value) {
        var match = DISTRICT.matcher(value.replaceFirst("^\\[(.*)]$", "$1"));
        return match.matches() ? match.group(1).replaceFirst("^0+(?=\\d)", "") + "구역" : null;
    }

    private static String round(String input, boolean followedByDistrict) {
        var mark = MARKER.matcher(input);
        boolean marked = mark.find();
        String label = clean(marked ? input.substring(mark.end()) : input);
        var named = NAMED_ROUND.matcher(label);
        boolean defined = named.matches();
        String value = (defined ? named.group(1) : label).replaceFirst("\\s*콜링$", "").strip();
        String compact = CallingRules.searchKey(value);
        if (compact.matches("신규|\\d+(?:회)?차")) return compact;
        if (compact.matches("추가(?:회차)?")) return "추가회차";
        return !value.isEmpty() && !value.matches(".*[/／].*") && (marked || defined || label.endsWith("콜링")
                || compact.equals("수능인원") || followedByDistrict) ? value : null;
    }

    private static LocalDate date(String raw, String fallbackYear) {
        var match = DATE.matcher(raw.strip());
        if (!match.matches()) throw CallingRules.invalid("일보 날짜는 11/22 또는 2026-11-22 형식으로 입력해 주세요.");
        String year = match.group(1) == null ? fallbackYear : match.group(1);
        if (year.isEmpty()) throw CallingRules.invalid("일보 날짜에 연도가 없으면 조회할 연도를 입력해 주세요.");
        return CallingImportParser.calendar(Integer.parseInt(year), Integer.parseInt(match.group(2)), Integer.parseInt(match.group(3)));
    }
}
