package com.smoa.calling;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.List;

import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.FillPatternType;
import org.apache.poi.ss.usermodel.IndexedColors;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.util.CellRangeAddress;
import org.apache.poi.ss.util.CellRangeAddressList;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.stereotype.Component;

@Component
class CallingXlsx {
    static final List<String> HEADERS = List.of("인도자", "인도자구역", "대상자명", "콜링자", "콜링날짜",
            "콜링시간", "차수", "콜링결과", "특이사항", "대상자ID");
    private static final List<String> STATS = List.of("콜링자", "시간대", "차수", "시도", "연결", "연결률(%)");

    byte[] records(List<CallingService.View> rows) throws IOException {
        return records(rows, false, false);
    }

    byte[] reportRows(List<CallingService.View> rows) throws IOException {
        return records(rows, false, true);
    }

    byte[] template() throws IOException {
        return records(List.of(), true, false);
    }

    private byte[] records(List<CallingService.View> rows, boolean template, boolean report) throws IOException {
        try (var workbook = new XSSFWorkbook()) {
            workbook.getProperties().getCoreProperties().setSubjectProperty(report ? "SMOA 콜링 일보 v1" : "SMOA 콜링 회차 v2");
            var headers = template ? HEADERS.subList(0, 9) : HEADERS;
            var sheet = heading(workbook, "콜링", headers);
            sheet.setColumnWidth(8, 42 * 256);
            sheet.setAutoFilter(new CellRangeAddress(0, rows.size(), 0, headers.size() - 1));
            var dateStyle = workbook.createCellStyle();
            dateStyle.setDataFormat(workbook.createDataFormat().getFormat("yyyy-mm-dd"));
            var timeStyle = workbook.createCellStyle();
            timeStyle.setDataFormat(workbook.createDataFormat().getFormat("hh:mm"));
            var notes = workbook.createCellStyle();
            notes.setWrapText(true);
            sheet.setDefaultColumnStyle(4, dateStyle);
            sheet.setDefaultColumnStyle(5, timeStyle);
            if (template) {
                choices(sheet, 6, CallingRules.ROUNDS);
                choices(sheet, 7, CallingRules.RESULTS);
            }
            int i = 1;
            for (var item : rows) {
                var row = sheet.createRow(i++);
                text(row, 0, item.introducer());
                text(row, 1, item.districtName());
                text(row, 2, item.personName());
                text(row, 3, item.caller());
                var date = row.createCell(4);
                date.setCellValue(item.date());
                date.setCellStyle(dateStyle);
                if (!item.time().isEmpty()) {
                    var clock = java.time.LocalTime.parse(item.time());
                    var time = row.createCell(5);
                    time.setCellValue(clock.toSecondOfDay() / 86400.0);
                    time.setCellStyle(timeStyle);
                }
                text(row, 6, item.roundLabel());
                text(row, 7, item.resultText());
                text(row, 8, item.notes()).setCellStyle(notes);
                text(row, 9, item.personCode());
            }
            return bytes(workbook);
        }
    }

    private static void choices(Sheet sheet, int column, List<String> values) {
        var helper = sheet.getDataValidationHelper();
        var list = helper.createExplicitListConstraint(values.toArray(String[]::new));
        var validation = helper.createValidation(list, new CellRangeAddressList(1, CallingImportParser.MAX_ROWS, column, column));
        validation.setShowErrorBox(false);
        sheet.addValidationData(validation);
    }

    byte[] stats(CallingStatistics.Summary summary) throws IOException {
        try (var workbook = new XSSFWorkbook()) {
            var top = heading(workbook, "요약", List.of("항목", "수치"));
            var totals = summary.totals();
            var lag = summary.lag();
            Object[][] values = {{"총 시도", totals.count()}, {"연결", totals.successes()}, {"연결률(%)", totals.rate()},
                    {"대상자", totals.targets()}, {"콜링자", totals.callerCount()}, {"시간 미입력", summary.missingTime()},
                    {"연결까지 걸린 기간 집계 건수", lag.count()}, {"찾은 날짜 확인 불가", lag.missing()},
                    {"평균(일)", lag.average()}, {"중앙값(일)", lag.median()}, {"80백분위(일)", lag.p80()}};
            top.setColumnWidth(0, 34 * 256);
            for (int i = 0; i < values.length; i++) {
                Row row = top.createRow(i + 1);
                text(row, 0, (String) values[i][0]);
                number(row, 1, (Number) values[i][1]);
            }
            Sheet within = heading(workbook, "연결까지 걸린 일수", List.of("기준일", "연결", "비율(%)"));
            int i = 1;
            for (var group : lag.within()) {
                Row row = within.createRow(i++);
                number(row, 0, group.days());
                number(row, 1, group.count());
                number(row, 2, group.rate());
            }
            statsSheet(workbook, "시간대별", summary.byHour());
            statsSheet(workbook, "콜링자별", summary.byCaller());
            statsSheet(workbook, "차수별", summary.byRound());
            statsSheet(workbook, "콜링자와 시간대별", summary.byCallerHour());
            statsSheet(workbook, "콜링자와 차수별", summary.byCallerRound());
            if (!summary.connected().isEmpty()) {
                var connected = heading(workbook, "연결된 콜링자와 인도자", List.of("콜링자", "인도자"));
                i = 1;
                for (var pair : summary.connected()) {
                    Row row = connected.createRow(i++);
                    text(row, 0, pair.caller());
                    text(row, 1, pair.introducer());
                }
            }
            var report = workbook.createSheet("결과 보고");
            report.setColumnWidth(0, 80 * 256);
            i = 0;
            for (String line : summary.report().split("\n", -1)) text(report.createRow(i++), 0, line);
            return bytes(workbook);
        }
    }

    private static void statsSheet(XSSFWorkbook workbook, String name, List<CallingStatistics.Group> groups) {
        Sheet sheet = heading(workbook, name, STATS);
        int i = 1;
        for (var group : groups) {
            Row row = sheet.createRow(i++);
            text(row, 0, group.caller());
            number(row, 1, group.hour());
            text(row, 2, group.roundLabel());
            number(row, 3, group.count());
            number(row, 4, group.successes());
            number(row, 5, group.rate());
        }
    }

    private static Sheet heading(XSSFWorkbook workbook, String name, List<String> labels) {
        var sheet = workbook.createSheet(name);
        var style = workbook.createCellStyle();
        var font = workbook.createFont();
        font.setBold(true);
        font.setColor(IndexedColors.WHITE.getIndex());
        style.setFont(font);
        style.setFillForegroundColor(IndexedColors.DARK_BLUE.getIndex());
        style.setFillPattern(FillPatternType.SOLID_FOREGROUND);
        sheet.createFreezePane(0, 1);
        var header = sheet.createRow(0);
        header.setHeightInPoints(24);
        for (int i = 0; i < labels.size(); i++) {
            text(header, i, labels.get(i)).setCellStyle(style);
            sheet.setColumnWidth(i, 20 * 256);
        }
        return sheet;
    }

    private static Cell text(Row row, int column, String value) {
        var cell = row.createCell(column);
        if (value != null) cell.setCellValue(value);
        return cell;
    }

    private static void number(Row row, int column, Number value) {
        if (value != null) row.createCell(column).setCellValue(value.doubleValue());
    }

    private static byte[] bytes(XSSFWorkbook workbook) throws IOException {
        try (var out = new ByteArrayOutputStream()) {
            workbook.write(out);
            return out.toByteArray();
        }
    }
}
