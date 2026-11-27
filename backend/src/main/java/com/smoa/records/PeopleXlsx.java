package com.smoa.records;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.List;

import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.stereotype.Component;

/**
 * 대상자 목록 XLSX 생성(Apache POI). 원본 엑셀 필드를 모두 담되 연락처는 <b>끝 네 자리</b>만 나간다(원문·암호문 없음).
 * 앞 12개 열(식별번호~담당자)의 순서는 기존 내보내기와 같고 나머지 원본 필드가 뒤에 붙는다.
 * 수식으로 해석될 수 있는 문자열은 앞에 작은따옴표를 붙여 무력화한다.
 */
@Component
public class PeopleXlsx {

    public static final List<String> HEADERS = List.of("식별번호", "이름", "성별", "나이", "지역", "구역", "단계", "상태",
            "분류1", "분류2", "등록일", "담당자",
            "나이 기준일", "찾은 시간", "날짜 미상", "찾은 장소", "사용 도구", "거주지", "교사", "사유",
            "인도자 ID", "인도자 구성원ID", "인도자 이름", "인도자 소속", "반", "직업", "확정 일정", "메모",
            "만픽일", "찾A일", "합B일", "합A일", "영따일", "복신일", "신카접수일", "센터등록일", "사용자 정의", "끝 네 자리");

    private static final List<PersonField> TAIL_FIELDS = List.of(PersonField.AGE_AS_OF, PersonField.FOUND_TIME,
            PersonField.DATE_UNKNOWN, PersonField.PLACE, PersonField.TOOL, PersonField.RESIDENCE, PersonField.TEACHER,
            PersonField.REASON, PersonField.INTRODUCER_ID, PersonField.INTRODUCER_CODE, PersonField.INTRODUCER_NAME,
            PersonField.INTRODUCER_ORG, PersonField.CLASS_NAME, PersonField.EMPLOYMENT, PersonField.APPOINTMENT,
            PersonField.NOTES, PersonField.MANPIK_DATE, PersonField.FIND_A_DATE, PersonField.HAB_B_DATE,
            PersonField.HAB_A_DATE, PersonField.YOUNG_TTA_DATE, PersonField.BOKSHIN_DATE, PersonField.CARD_RECEIVED_DATE,
            PersonField.CENTER_REGISTERED_DATE, PersonField.CUSTOM);

    public byte[] write(List<Person> people) throws IOException {
        try (XSSFWorkbook workbook = new XSSFWorkbook(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Sheet sheet = workbook.createSheet("대상자");
            Row header = sheet.createRow(0);
            for (int i = 0; i < HEADERS.size(); i++) {
                header.createCell(i).setCellValue(HEADERS.get(i));
            }
            int rowIndex = 1;
            for (Person p : people) {
                Row row = sheet.createRow(rowIndex++);
                int c = 0;
                row.createCell(c++).setCellValue(safe(p.code()));
                row.createCell(c++).setCellValue(safe(p.name()));
                row.createCell(c++).setCellValue(safe(p.str(PersonField.GENDER)));
                Object age = p.values().get(PersonField.AGE);
                if (age instanceof Number n) {
                    row.createCell(c).setCellValue(n.doubleValue());
                }
                c++;
                row.createCell(c++).setCellValue(safe(p.str(PersonField.REGION_CODE)));
                row.createCell(c++).setCellValue(safe(p.str(PersonField.DISTRICT_CODE)));
                row.createCell(c++).setCellValue(safe(p.stageId()));
                row.createCell(c++).setCellValue(safe(p.status()));
                row.createCell(c++).setCellValue(safe(p.str(PersonField.CLASSIFICATION1)));
                row.createCell(c++).setCellValue(safe(p.str(PersonField.CLASSIFICATION2)));
                row.createCell(c++).setCellValue(safe(p.str(PersonField.FOUND_DATE)));
                row.createCell(c++).setCellValue(safe(p.str(PersonField.WORKER)));
                for (PersonField field : TAIL_FIELDS) {
                    Object v = p.values().get(field);
                    String text = field == PersonField.DATE_UNKNOWN ? (Boolean.TRUE.equals(v) ? "Y" : "") : v == null ? "" : v.toString();
                    row.createCell(c++).setCellValue(safe(text));
                }
                row.createCell(c).setCellValue(safe(p.phoneLast4()));
            }
            workbook.write(out);
            return out.toByteArray();
        }
    }

    static String safe(String value) {
        if (value == null) {
            return "";
        }
        return !value.isEmpty() && "=+-@\t\r".indexOf(value.charAt(0)) >= 0 ? "'" + value : value;
    }
}
