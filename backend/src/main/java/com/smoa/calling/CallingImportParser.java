package com.smoa.calling;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.zip.ZipInputStream;

import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.ss.usermodel.DateUtil;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;

import com.smoa.common.ApiException;

final class CallingImportParser {
    record Input(String sheet, int row, String personName, String introducer, String area, String personCode,
            LocalDate date, LocalTime time, String round, String result, String caller, String notes) {
    }

    record Issue(String sheet, int row, String message) {
    }

    record Parsed(List<Input> rows, List<Issue> errors, int errorCount, int totalRows, boolean legacyFifth,
            boolean report, List<String> warnings) {
    }

    static final int MAX_ROWS = 2000;
    static final int MAX_FILE = 1_000_000;
    private static final int MAX_ZIP = 32 * 1024 * 1024;
    private static final Pattern DATE = Pattern.compile("^(\\d{4})([-./])(\\d{1,2})\\2(\\d{1,2})\\.?$");
    private static final Pattern CLOCK = Pattern.compile("^(\\d{1,2}):?(\\d{2})$");
    private static final Pattern HOUR = Pattern.compile("^(\\d{1,2})(?:시(?:(\\d{1,2})분)?)?$");
    private static final List<String> REQUIRED = CallingXlsx.HEADERS.subList(0, 8);

    private CallingImportParser() {
    }

    static Parsed workbook(byte[] bytes, boolean migration) {
        if (bytes.length == 0 || bytes.length > MAX_FILE) throw CallingRules.invalid("콜링 엑셀은 1MB 이하의 XLSX 파일을 선택해 주세요.");
        checkZip(bytes);
        try (var book = new XSSFWorkbook(new ByteArrayInputStream(bytes))) {
            var sheets = book.sheetIterator();
            Map<org.apache.poi.ss.usermodel.Sheet, Map<String, Integer>> candidates = new LinkedHashMap<>();
            Map.Entry<org.apache.poi.ss.usermodel.Sheet, Map<String, Integer>> named = null;
            while (sheets.hasNext()) {
                var sheet = sheets.next();
                var cols = columns(sheet.getRow(0));
                if (List.of("콜링", "콜링기록").contains(CallingRules.searchKey(sheet.getSheetName())) && named == null) named = Map.entry(sheet, cols);
                if (cols.keySet().containsAll(REQUIRED)) candidates.put(sheet, cols);
            }
            var picked = named != null ? named : candidates.size() == 1 ? candidates.entrySet().iterator().next() : null;
            if (picked == null) throw CallingRules.invalid("콜링 시트와 첫 행의 머리글을 확인해 주세요.");
            var sheet = picked.getKey();
            var columns = picked.getValue();
            for (String h : CallingXlsx.HEADERS) {
                if ((REQUIRED.contains(h) || columns.containsKey(h)) && columns.getOrDefault(h, -1) < 0) {
                    throw CallingRules.invalid("머리글의 누락이나 중복을 확인해 주세요. " + h);
                }
            }
            for (var merge : sheet.getMergedRegions()) {
                if (merge.getFirstRow() == 0 && columns.values().stream().anyMatch(c -> c >= merge.getFirstColumn() && c <= merge.getLastColumn())) {
                    throw CallingRules.invalid("머리글의 병합을 해제해 주세요.");
                }
            }
            if (sheet.getLastRowNum() > MAX_ROWS) throw rowLimit();
            String subject = book.getProperties().getCoreProperties().getSubject();
            boolean report = "SMOA 콜링 일보 v1".equals(subject);
            boolean legacyFifth = !report && (migration || !"SMOA 콜링 회차 v2".equals(subject));
            var parser = new Collected();
            var format = new DataFormatter(java.util.Locale.KOREA);
            var merged = mergedInputRows(sheet, columns);
            long textSize = 0;
            for (Row row : sheet) {
                if (row.getRowNum() == 0 || columns.values().stream().map(row::getCell).noneMatch(c -> hasText(c, format))) continue;
                int i = row.getRowNum() + 1;
                String name = sheet.getSheetName();
                parser.total++;
                textSize += columns.values().stream().map(row::getCell)
                        .filter(c -> c != null && c.getCellType() == CellType.STRING)
                        .mapToLong(c -> c.getStringCellValue().length()).sum();
                if (textSize > 1_000_000) throw CallingRules.invalid("파일의 입력 문자가 너무 많습니다. 시트를 나눠 가져와 주세요.");
                try {
                    if (merged[row.getRowNum()]) throw CallingRules.invalid("입력한 셀의 병합을 해제해 주세요.");
                    if (columns.values().stream().map(row::getCell).anyMatch(c -> c != null && (c.getCellType() == CellType.FORMULA || c.getCellType() == CellType.ERROR))) {
                        throw CallingRules.invalid("수식 또는 오류 셀을 값으로 바꿔 주세요.");
                    }
                    Cell d = row.getCell(columns.get("콜링날짜"));
                    LocalDate day = d != null && d.getCellType() == CellType.NUMERIC && DateUtil.isCellDateFormatted(d)
                            ? DateUtil.getLocalDateTime(d.getNumericCellValue(), book.isDate1904()).toLocalDate()
                            : date(format.formatCellValue(d));
                    Cell t = row.getCell(columns.get("콜링시간"));
                    LocalTime time = t != null && t.getCellType() == CellType.NUMERIC
                            ? time(t.getNumericCellValue()) : time(format.formatCellValue(t));
                    parser.rows.add(new Input(name, i, get(row, columns, format, "대상자명"), get(row, columns, format, "인도자"),
                            get(row, columns, format, "인도자구역"), get(row, columns, format, "대상자ID"), day, time,
                            get(row, columns, format, "차수"), get(row, columns, format, "콜링결과"),
                            get(row, columns, format, "콜링자"), get(row, columns, format, "특이사항")));
                } catch (ApiException e) { parser.issue(name, i, e.getMessage()); }
            }
            return parser.result(legacyFifth, report, List.of());
        } catch (ApiException e) {
            throw e;
        } catch (IOException | RuntimeException e) {
            throw CallingRules.invalid("콜링 XLSX 파일을 읽지 못했습니다. 파일 형식과 내용을 확인해 주세요.");
        }
    }

    private static void checkZip(byte[] bytes) {
        try (var zip = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            byte[] buffer = new byte[8192];
            int size = 0, entries = 0;
            while (zip.getNextEntry() != null) {
                if (++entries > 512) throw CallingRules.invalid("엑셀 파일 내부 항목이 너무 많습니다.");
                for (int n; (n = zip.read(buffer)) != -1; ) {
                    size += n;
                    if (size > MAX_ZIP) throw CallingRules.invalid("엑셀 파일에서 압축 해제할 데이터가 너무 많습니다.");
                }
            }
            if (entries == 0) throw CallingRules.invalid("XLSX 파일을 선택해 주세요.");
        } catch (IOException e) {
            throw CallingRules.invalid("콜링 XLSX 파일을 읽지 못했습니다.");
        }
    }

    private static Map<String, Integer> columns(Row header) {
        Map<String, Integer> out = new HashMap<>();
        if (header == null) return out;
        Map<String, String> names = new HashMap<>();
        CallingXlsx.HEADERS.forEach(h -> names.put(CallingRules.searchKey(h), h));
        names.put("대상자코드", "대상자ID");
        for (Cell cell : header) {
            if (cell.getCellType() != CellType.STRING) continue;
            String name = names.get(CallingRules.searchKey(cell.getStringCellValue()));
            if (name != null) out.merge(name, cell.getColumnIndex(), (a, b) -> -1);
        }
        return out;
    }

    private static boolean[] mergedInputRows(org.apache.poi.ss.usermodel.Sheet sheet, Map<String, Integer> columns) {
        boolean[] result = new boolean[sheet.getLastRowNum() + 1];
        for (var merge : sheet.getMergedRegions()) {
            if (columns.values().stream().noneMatch(c -> c >= merge.getFirstColumn() && c <= merge.getLastColumn())) continue;
            for (int i = Math.max(1, merge.getFirstRow()); i <= Math.min(result.length - 1, merge.getLastRow()); i++) result[i] = true;
        }
        return result;
    }

    private static String get(Row row, Map<String, Integer> columns, DataFormatter format, String header) {
        Integer index = columns.get(header);
        if (index == null) return "";
        var cell = row.getCell(index);
        return cell != null && cell.getCellType() == CellType.STRING ? cell.getStringCellValue() : format.formatCellValue(cell);
    }

    private static boolean hasText(Cell cell, DataFormatter format) {
        return cell != null && !format.formatCellValue(cell).isBlank();
    }

    static LocalDate date(String value) {
        var matcher = DATE.matcher(value.strip());
        if (!matcher.matches()) throw CallingRules.invalid("콜링 날짜는 엑셀 날짜 또는 YYYY-MM-DD 형식으로 입력해 주세요.");
        return calendar(Integer.parseInt(matcher.group(1)), Integer.parseInt(matcher.group(3)), Integer.parseInt(matcher.group(4)));
    }

    static LocalDate calendar(int year, int month, int day) {
        try {
            if (year < 1000 || year > 9999) throw CallingRules.invalid("콜링 날짜를 확인해 주세요.");
            return LocalDate.of(year, month, day);
        } catch (java.time.DateTimeException e) {
            throw CallingRules.invalid("콜링 날짜를 확인해 주세요.");
        }
    }

    private static LocalTime time(double n) {
        if (n >= 0 && n < 1) return LocalTime.ofSecondOfDay(Math.round(n * 86400) % 86400);
        if (n >= 1 && n <= 2359 && n == Math.rint(n)) return time(Integer.toString((int) n));
        throw CallingRules.invalid("콜링 시간을 확인해 주세요.");
    }

    static LocalTime time(String value) {
        String s = value.strip();
        if (s.isBlank()) return null;
        var result = CLOCK.matcher(s);
        if (!result.matches()) result = HOUR.matcher(s);
        if (!result.matches()) {
            if (s.matches("\\d{2}:\\d{2}:\\d{2}")) return CallingRules.time(s);
            throw CallingRules.invalid("콜링 시간은 17, 17:00, 1700처럼 입력해 주세요.");
        }
        try {
            return LocalTime.of(Integer.parseInt(result.group(1)), result.group(2) == null ? 0 : Integer.parseInt(result.group(2)));
        } catch (java.time.DateTimeException e) {
            throw CallingRules.invalid("콜링 시간을 확인해 주세요.");
        }
    }

    static final class Collected {
        final List<Input> rows = new ArrayList<>();
        final List<Issue> errors = new ArrayList<>();
        int total;
        int errorCount;

        void issue(String sheet, int row, String message) {
            errorCount++;
            if (errors.size() < 50) errors.add(new Issue(sheet, row, message));
        }

        Parsed result(boolean legacyFifth, boolean report, List<String> warnings) {
            if (total == 0 && errorCount == 0) issue(report ? "콜링 일보" : "콜링", 1, "가져올 콜링 기록이 없습니다.");
            if (total > MAX_ROWS) throw rowLimit();
            return new Parsed(List.copyOf(rows), List.copyOf(errors), errorCount, total, legacyFifth, report, List.copyOf(warnings));
        }
    }

    private static ApiException rowLimit() {
        return CallingRules.invalid("한 번에 가져올 수 있는 콜링 기록은 2,000행입니다.");
    }
}
