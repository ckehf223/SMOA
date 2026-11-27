package com.smoa.organization;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.List;
import java.util.Map;

import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.context.annotation.Profile;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.smoa.organization.BusinessService.Filters;
import com.smoa.organization.BusinessWriteService.ActivityInput;
import com.smoa.organization.BusinessWriteService.GoalInput;
import com.smoa.organization.BusinessWriteService.MemberInput;
import com.smoa.security.CurrentAccount;

@RestController
@RequestMapping("/api/programs")
@Profile({"local", "prod"})
public class BusinessController {
    private static final MediaType XLSX =
            MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    private final BusinessService service;
    private final BusinessWriteService write;
    private final RegionDataService regionData;

    public BusinessController(BusinessService service, BusinessWriteService write, RegionDataService regionData) {
        this.service = service;
        this.write = write;
        this.regionData = regionData;
    }

    @GetMapping("/organization/data/list")
    public Map<String, Object> organization(@ModelAttribute Filters filters) {
        return service.organization(CurrentAccount.require(), filters);
    }

    @GetMapping("/codes/data/list")
    public Map<String, Object> codes() {
        return service.codes();
    }

    @GetMapping("/goals/data/list")
    public Map<String, Object> goals(@ModelAttribute Filters filters) {
        return service.goals(CurrentAccount.require(), filters);
    }

    @GetMapping("/regionalActivity/data/list")
    public Map<String, Object> regionalActivity(@ModelAttribute Filters filters) {
        return service.regionalActivity(CurrentAccount.require(), filters);
    }

    @GetMapping("/socialingManage/data/list")
    public Map<String, Object> socialing(@ModelAttribute Filters filters) {
        return service.socialing(CurrentAccount.require(), filters);
    }

    @GetMapping("/socialingStats/data/list")
    public Map<String, Object> socialingStats(@ModelAttribute Filters filters) {
        return service.socialingStats(CurrentAccount.require(), filters);
    }

    @GetMapping("/socialingManage/export")
    public ResponseEntity<byte[]> exportSocialing(@ModelAttribute Filters filters) throws IOException {
        return export("socialing.xlsx", "접수 목록", rows(socialing(filters), "items"),
                "date", "접수일", "programName", "프로그램", "name", "이름", "introducerName", "인도자",
                "regionName", "지역", "districtName", "구역", "status", "진행 상태");
    }

    @GetMapping("/socialingStats/export")
    public ResponseEntity<byte[]> exportSocialingStats(@ModelAttribute Filters filters) throws IOException {
        return export("socialing-stats.xlsx", "월별 소셜링", rows(socialingStats(filters), "items"),
                "month", "접수월", "programName", "프로그램", "total", "접수", "pending", "미전환", "converted", "전환");
    }

    @GetMapping("/regionData/data/overview")
    public RegionDataService.Result regionOverview(@ModelAttribute RegionDataService.Query filters) {
        return regionData.overview(CurrentAccount.require(), filters);
    }

    @GetMapping("/regionData/export")
    public ResponseEntity<byte[]> exportRegionData(@ModelAttribute RegionDataService.Query filters) throws IOException {
        var result = regionOverview(filters);
        try (var workbook = new XSSFWorkbook(); var bytes = new ByteArrayOutputStream()) {
            var district = workbook.createSheet("구역별");
            xlsxRow(district.createRow(0), "구역", "명부", "노방 참여", "소셜링 참여", "합산 참여", "노방 분",
                    "노방 활동 중 찾기", "찾기", "이전 기간 찾기", "증감");
            var groups = new java.util.ArrayList<>(result.items());
            groups.add(result.total());
            for (int index = 0; index < groups.size(); index++) {
                var item = groups.get(index);
                xlsxRow(district.createRow(index + 1), item.name(), item.members(), item.street(), item.socialing(),
                        item.combined(), item.minutes(), item.matched(), item.findings(), item.previous(), item.change());
            }
            district.createFreezePane(0, 1);
            for (var entry : Map.of("일자별", result.days(), "시간대별", result.hours()).entrySet()) {
                var sheet = workbook.createSheet(entry.getKey());
                xlsxRow(sheet.createRow(0), entry.getKey(), "찾기", "노방 찾기", "노방 활동 중 찾기", "노방 분");
                int index = 1;
                for (var item : entry.getValue()) {
                    xlsxRow(sheet.createRow(index++), item.time(), item.findings(), item.streetFindings(), item.matched(), item.minutes());
                }
                sheet.createFreezePane(0, 1);
            }
            workbook.write(bytes);
            return xlsx("region-data.xlsx", bytes);
        }
    }

    private static void xlsxRow(org.apache.poi.ss.usermodel.Row row, Object... values) {
        for (int index = 0; index < values.length; index++) {
            var cell = row.createCell(index);
            if (values[index] instanceof Number number) {
                cell.setCellValue(number.doubleValue());
            } else {
                cell.setCellValue(values[index].toString());
            }
        }
    }

    @PostMapping("/organization/data/members")
    public Map<String, String> addMember(@RequestBody MemberInput input) {
        return write.saveMember(CurrentAccount.require(), null, input);
    }

    @PutMapping("/organization/data/members/{id}")
    public Map<String, String> editMember(@PathVariable String id, @RequestBody MemberInput input) {
        return write.saveMember(CurrentAccount.require(), id, input);
    }

    @DeleteMapping("/organization/data/members/{id}")
    public ResponseEntity<Void> archiveMember(@PathVariable String id, @RequestParam String version) {
        write.archiveMember(CurrentAccount.require(), id, version);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/goals/data/items")
    public Map<String, String> addGoal(@RequestBody GoalInput input) {
        return write.saveGoal(CurrentAccount.require(), null, input);
    }

    @PutMapping("/goals/data/items/{id}")
    public Map<String, String> updateGoal(@PathVariable String id, @RequestBody GoalInput input) {
        return write.saveGoal(CurrentAccount.require(), id, input);
    }

    @DeleteMapping("/goals/data/items/{id}")
    public ResponseEntity<Void> deleteGoal(@PathVariable String id, @RequestParam String version) {
        write.deleteGoal(CurrentAccount.require(), id, version);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/regionalActivity/data/items")
    public Map<String, String> addActivity(@RequestBody ActivityInput input) {
        return write.saveActivity(CurrentAccount.require(), null, input);
    }

    @PutMapping("/regionalActivity/data/items/{id}")
    public Map<String, String> updateActivity(@PathVariable String id, @RequestBody ActivityInput input) {
        return write.saveActivity(CurrentAccount.require(), id, input);
    }

    @DeleteMapping("/regionalActivity/data/items/{id}")
    public ResponseEntity<Void> deleteActivity(@PathVariable String id, @RequestParam String version) {
        write.deleteActivity(CurrentAccount.require(), id, version);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/organization/export")
    public ResponseEntity<byte[]> exportOrganization(@ModelAttribute Filters filters) throws IOException {
        return export("organization.xlsx", "구성원", rows(organization(filters), "members"),
                "code", "구성원ID", "name", "이름", "regionName", "지역", "districtName", "구역",
                "className", "반", "title", "직책", "job", "직업구분", "status", "상태", "useInd", "사용여부");
    }

    @GetMapping("/goals/export")
    public ResponseEntity<byte[]> exportGoals(@ModelAttribute Filters filters) throws IOException {
        return export("goals.xlsx", "목표", rows(goals(filters), "items"),
                "regionName", "지역", "districtName", "구역", "className", "반", "from", "시작일", "to", "종료일",
                "stageName", "단계", "periodUnit", "기간", "target", "목표", "actual", "실적",
                "shortfall", "부족", "rate", "달성률(%)");
    }

    @GetMapping("/regionalActivity/export")
    public ResponseEntity<byte[]> exportActivity(@ModelAttribute Filters filters) throws IOException {
        return export("regional-activity.xlsx", "지역활동기록", rows(regionalActivity(filters), "items"),
                "memberCode", "구성원ID", "memberName", "이름", "regionName", "지역", "districtName", "구역",
                "month", "활동 월", "date", "일자", "statusName", "활동 상태");
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> rows(Map<String, Object> response, String field) {
        return (List<Map<String, Object>>) response.get(field);
    }

    private static ResponseEntity<byte[]> export(String filename, String sheetName, List<Map<String, Object>> rows,
            String... columns) throws IOException {
        try (var workbook = new XSSFWorkbook(); var bytes = new ByteArrayOutputStream()) {
            var sheet = workbook.createSheet(sheetName);
            var header = sheet.createRow(0);
            for (int c = 0; c < columns.length; c += 2) {
                header.createCell(c / 2).setCellValue(columns[c + 1]);
            }
            for (int r = 0; r < rows.size(); r++) {
                var row = sheet.createRow(r + 1);
                for (int c = 0; c < columns.length; c += 2) {
                    var cell = row.createCell(c / 2);
                    Object value = rows.get(r).get(columns[c]);
                    if (value instanceof Number number) {
                        cell.setCellValue(number.doubleValue());
                    } else if (value != null) {
                        cell.setCellValue(value.toString());
                    }
                }
            }
            sheet.createFreezePane(0, 1);
            workbook.write(bytes);
            return xlsx(filename, bytes);
        }
    }

    private static ResponseEntity<byte[]> xlsx(String filename, ByteArrayOutputStream bytes) {
        return ResponseEntity.ok().contentType(XLSX)
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename(filename).build().toString())
                .body(bytes.toByteArray());
    }
}
