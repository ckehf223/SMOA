package com.smoa.imports;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.stereotype.Service;

import com.smoa.access.AccessGrant;
import com.smoa.callingsheet.PhoneMasker;
import com.smoa.common.ApiException;
import com.smoa.permission.DistrictKey;
import com.smoa.reference.ReferenceRepository;
import com.smoa.scope.ScopeEnforcer;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

@Service
public class ReportWorkbookService {

    public record DistrictOption(String regionCode, String districtCode, String regionName, String districtName) {}
    public record Conversion(
            @NotNull @Size(max = 10000) List<@NotNull @Valid ActivityRow> activities,
            @NotNull @Size(max = 10000) List<@NotNull @Valid PersonRow> people) {}
    public record ActivityRow(@NotBlank @Size(max = 60) String regionCode, @NotBlank @Size(max = 60) String districtCode,
            @NotBlank @Size(max = 10) String reportDate, @NotBlank @Size(max = 100) String name, int status) {}
    public record PersonRow(@NotBlank @Size(max = 60) String regionCode, @NotBlank @Size(max = 60) String districtCode,
            @NotBlank @Size(max = 10) String reportDate, @NotBlank @Size(max = 10) String date,
            @NotBlank @Size(max = 60) String stage, @NotBlank @Size(max = 10) String status,
            @NotBlank @Size(max = 100) String name, @Size(max = 20) String classification1, @Size(max = 20) String classification2,
            @Size(max = 200) String method, @Size(max = 20) String gender, Integer age, @Size(max = 200) String residence,
            @Size(max = 200) String place, @Size(max = 30) String time, @Size(max = 100) String introducer,
            @Size(max = 100) String teacher, @Size(max = 500) String reason) {}

    private record Template(String id, String title, Map<String, List<String>> sheets) {}

    private static final List<String> ACTIVITY = List.of("보고일", "지역", "구역", "이름", "활동여부");
    private static final List<String> PEOPLE = List.of("보고일", "지역", "구역", "찾은날짜·적용일", "단계", "상태", "대상자",
            "분류1", "분류2", "도구", "성별", "나이", "거주지", "찾기장소", "찾기시간", "인도자", "상담사", "탈락사유");
    private static final List<String> ACTIVITY_STATUSES = List.of("적극적 활동자", "전도비 후원자", "소극적 활동자", "비활동자");
    private static final List<Template> TEMPLATES = List.of(
            new Template("target-input", "대상자 입력 양식", Map.of("대상자", List.of("대상자ID", "이름", "구역", "반", "담당자",
                    "찾은날짜", "분류1", "분류2", "성별", "나이", "나이기준일", "직장인구분", "최초단계", "메모",
                    "인도자ID", "만픽일", "찾A일", "복신일"))),
            new Template("activity-input", "활동 기록 양식", Map.of("활동기록", List.of("날짜", "활동자", "시작", "종료", "구역", "장소", "종류", "메모"))),
            new Template("daily-input", "일보 확인 양식", Map.of("활동자", ACTIVITY, "찾기", PEOPLE, "업데이트", PEOPLE)));

    private final ReferenceRepository reference;
    private final ScopeEnforcer scope;

    public ReportWorkbookService(ReferenceRepository reference, ScopeEnforcer scope) {
        this.reference = reference;
        this.scope = scope;
    }

    public List<DistrictOption> districts(AccessGrant grant) {
        var visible = scope.visibility(grant);
        var names = new java.util.HashMap<String, String>();
        reference.regions().forEach(region -> names.put(region.regionCode(), region.name()));
        return reference.districts().stream().filter(district -> visible.test(district.key()))
                .map(district -> new DistrictOption(district.key().regionCode(), district.key().districtCode(),
                        names.getOrDefault(district.key().regionCode(), ""), district.name())).toList();
    }

    public List<Map<String, String>> templates() {
        return TEMPLATES.stream().map(t -> Map.of("id", t.id(), "name", t.title())).toList();
    }

    public byte[] template(String id) throws IOException {
        Template template = TEMPLATES.stream().filter(t -> t.id().equals(id)).findFirst()
                .orElseThrow(() -> ApiException.notFound("양식을 찾을 수 없습니다."));
        try (Workbook book = new XSSFWorkbook()) {
            template.sheets().entrySet().stream().sorted(Map.Entry.comparingByKey())
                    .forEach(entry -> sheet(book, entry.getKey(), entry.getValue()));
            return bytes(book);
        }
    }

    public byte[] conversion(AccessGrant grant, Conversion conversion) throws IOException {
        if (conversion.activities().size() + conversion.people().size() > 10000) {
            throw ApiException.badRequest("REPORT_TOO_LARGE", "10,000행 이하로 변환하세요.");
        }
        Map<DistrictKey, DistrictOption> districts = new java.util.HashMap<>();
        districts(grant).forEach(d -> districts.put(new DistrictKey(d.regionCode(), d.districtCode()), d));
        try (Workbook book = new XSSFWorkbook()) {
            Sheet activities = sheet(book, "활동자", ACTIVITY);
            Sheet findings = sheet(book, "찾기", PEOPLE);
            Sheet updates = sheet(book, "업데이트", PEOPLE);
            for (ActivityRow entry : conversion.activities()) {
                DistrictOption d = lookup(districts, entry.regionCode(), entry.districtCode());
                if (entry.status() < 1 || entry.status() > ACTIVITY_STATUSES.size()) {
                    throw ApiException.badRequest("INVALID_ACTIVITY", "활동 상태를 확인하세요.");
                }
                add(activities, validDate(entry.reportDate()), d.regionName(), d.districtName(), entry.name(),
                        ACTIVITY_STATUSES.get(entry.status() - 1));
            }
            for (PersonRow entry : conversion.people()) {
                DistrictOption d = lookup(districts, entry.regionCode(), entry.districtCode());
                if (!List.of("신규", "유지", "탈락").contains(entry.status())) {
                    throw ApiException.badRequest("INVALID_REPORT_STATUS", "신규·유지·탈락 구분을 확인하세요.");
                }
                Sheet output = "찾B".equals(entry.stage()) && "신규".equals(entry.status()) ? findings : updates;
                add(output, validDate(entry.reportDate()), d.regionName(), d.districtName(), validDate(entry.date()),
                        entry.stage(), entry.status(), entry.name(), entry.classification1(), entry.classification2(),
                        entry.method(), entry.gender(), entry.age(), entry.residence(), entry.place(), entry.time(),
                        entry.introducer(), entry.teacher(), entry.reason());
            }
            return bytes(book);
        }
    }

    private static DistrictOption lookup(Map<DistrictKey, DistrictOption> districts, String region, String district) {
        DistrictOption option = DistrictKey.valid(region, district) ? districts.get(new DistrictKey(region, district)) : null;
        if (option == null) throw ApiException.forbidden("OUT_OF_SCOPE", "내보낼 수 있는 구역을 선택하세요.");
        return option;
    }

    private static String validDate(String text) {
        try {
            return LocalDate.parse(text).toString();
        } catch (DateTimeException ex) {
            throw ApiException.badRequest("INVALID_DATE", "보고일과 적용일을 확인하세요.");
        }
    }

    private static Sheet sheet(Workbook book, String name, List<String> labels) {
        Sheet sheet = book.createSheet(name);
        add(sheet, labels.toArray());
        sheet.createFreezePane(0, 1);
        for (int index = 0; index < labels.size(); index++) sheet.setColumnWidth(index, 18 * 256);
        return sheet;
    }

    private static void add(Sheet sheet, Object... values) {
        Row row = sheet.createRow(sheet.getPhysicalNumberOfRows());
        for (int i = 0; i < values.length; i++) {
            Object value = values[i];
            if (value == null) continue;
            if (value instanceof Number n) row.createCell(i).setCellValue(n.doubleValue());
            else row.createCell(i).setCellValue(PhoneMasker.mask(value.toString()).text());
        }
    }

    private static byte[] bytes(Workbook book) throws IOException {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            book.write(out);
            return out.toByteArray();
        }
    }
}
