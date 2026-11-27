package com.smoa.callingsheet;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.List;
import java.util.Map;

import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.stereotype.Component;

/**
 * 콜링시트 XLSX(Apache POI). 목록과 같은 필터·범위의 전체 행을 담는다.
 * <ul>
 *   <li>"콜링시트" 시트: 원본 21개 열 전부(연락처는 끝 네 자리만) + 1~5차 콜링자 5열. 특이사항·만픽 정보의 줄바꿈은 셀 안 줄바꿈으로 보존.</li>
 *   <li>"회차" 시트: 부모 행 ID 기준 모든 회차(기본 1~5차와 사용자 회차) 한 줄씩. 부모 시트의 5개 열에 없는 사용자 회차도 잃지 않는다.</li>
 *   <li>나이는 원문 문자열 그대로. 수식으로 해석될 수 있는 문자열은 앞에 작은따옴표를 붙여 무력화한다.</li>
 * </ul>
 */
@Component
public class CallingSheetXlsx {

    public static final List<String> HEADERS = List.of("ID", "콜링 상태", "찾기일", "콜링 결과", "대상자", "인도자",
            "연락처(끝 네 자리)", "지역", "구역", "구역 이름", "성별", "나이", "거주지", "선호 장소", "특이사항", "컨설팅 주제",
            "만픽 확정 날짜", "만픽 정보", "1차 콜링자", "2차 콜링자", "3차 콜링자", "4차 콜링자", "5차 콜링자", "콜링 담당");

    public static final List<String> ROUND_HEADERS = List.of("ID", "회차 코드", "회차 이름", "담당 계정 연결", "담당자");

    public byte[] write(List<SheetRow> rows, Map<String, String> districtNames) throws IOException {
        try (XSSFWorkbook workbook = new XSSFWorkbook(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            CellStyle wrap = workbook.createCellStyle();
            wrap.setWrapText(true);
            Sheet sheet = workbook.createSheet("콜링시트");
            header(sheet, HEADERS);
            int r = 1;
            for (SheetRow row : rows) {
                Row line = sheet.createRow(r++);
                int c = 0;
                put(line, c++, Long.toString(row.id()), null);
                put(line, c++, row.callStatus(), null);
                put(line, c++, row.foundDate(), null);
                put(line, c++, row.callResult(), null);
                put(line, c++, row.targetName(), null);
                put(line, c++, row.introducerName(), null);
                put(line, c++, row.phoneLast4(), null);
                put(line, c++, row.regionCode(), null);
                put(line, c++, row.districtCode(), null);
                put(line, c++, row.regionCode() == null || row.districtCode() == null ? ""
                        : districtNames.getOrDefault(row.regionCode() + "\u0000" + row.districtCode(), ""), null);
                put(line, c++, row.sexCode(), null);
                put(line, c++, row.ageText(), null);
                put(line, c++, row.residence(), null);
                put(line, c++, row.preferredPlace(), null);
                put(line, c++, row.notes(), wrap);
                put(line, c++, row.consultTopic(), null);
                put(line, c++, row.manpikConfirmedAt(), null);
                put(line, c++, row.manpikInfo(), wrap);
                for (String code : RoundEntry.DEFAULT_CODES) {
                    String caller = row.rounds().stream().filter(x -> x.code().equals(code)).map(RoundEntry::callerName)
                            .findFirst().orElse("");
                    put(line, c++, caller, null);
                }
                put(line, c, row.assignedUserName(), null);
            }
            Sheet rounds = workbook.createSheet("회차");
            header(rounds, ROUND_HEADERS);
            int rr = 1;
            for (SheetRow row : rows) {
                for (RoundEntry round : row.rounds()) {
                    Row line = rounds.createRow(rr++);
                    put(line, 0, Long.toString(row.id()), null);
                    put(line, 1, round.code(), null);
                    put(line, 2, round.label(), null);
                    put(line, 3, round.callerUserId() == null ? "아니오" : "예", null);
                    put(line, 4, round.callerName(), null);
                }
            }
            workbook.write(out);
            return out.toByteArray();
        }
    }

    private static void header(Sheet sheet, List<String> headers) {
        Row row = sheet.createRow(0);
        for (int i = 0; i < headers.size(); i++) {
            row.createCell(i).setCellValue(headers.get(i));
        }
    }

    private static void put(Row row, int column, String value, CellStyle style) {
        var cell = row.createCell(column);
        cell.setCellValue(safe(value));
        if (style != null) {
            cell.setCellStyle(style);
        }
    }

    static String safe(String value) {
        if (value == null) {
            return "";
        }
        return !value.isEmpty() && "=+-@\t\r".indexOf(value.charAt(0)) >= 0 ? "'" + value : value;
    }
}
