package com.smoa.analytics;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.List;

import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.smoa.callingsheet.PhoneMasker;
import com.smoa.security.CurrentAccount;

@RestController
@Profile({"local", "prod"})
@RequestMapping("/api/programs/{program:memberData|classData|stagePerformance}")
public class PerformanceController {

    private final AnalyticsService analytics;
    private final PerformanceService performance;

    public PerformanceController(AnalyticsService analytics, PerformanceService performance) {
        this.analytics = analytics;
        this.performance = performance;
    }

    @GetMapping("/options")
    public List<AnalyticsService.DistrictOption> options() {
        return analytics.districts(CurrentAccount.require());
    }

    @GetMapping("/data/summary")
    public PerformanceService.Overview summary(@PathVariable String program, @RequestParam(required = false) String from,
            @RequestParam(required = false) String to, @RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode, @RequestParam(required = false) String className,
            @RequestParam(required = false) String classification) {
        return performance.overview(CurrentAccount.require(), program, from, to, regionCode, districtCode, className,
                classification);
    }

    @GetMapping("/export/summary.xlsx")
    public ResponseEntity<byte[]> export(@PathVariable String program, @RequestParam(required = false) String from,
            @RequestParam(required = false) String to, @RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode, @RequestParam(required = false) String className,
            @RequestParam(required = false) String classification) throws IOException {
        var overview = summary(program, from, to, regionCode, districtCode, className, classification);
        try (var book = new XSSFWorkbook(); var bytes = new ByteArrayOutputStream()) {
            var sheet = book.createSheet("기간별 실적");
            boolean grouped = !program.equals("stagePerformance");
            var header = sheet.createRow(0);
            int column = 0;
            header.createCell(column++).setCellValue("구역");
            if (grouped) header.createCell(column++).setCellValue(program.equals("memberData") ? "활동자·인도자" : "반");
            for (var metric : overview.metrics()) header.createCell(column++).setCellValue(metric.label());
            int rowIndex = 1;
            for (var item : overview.rows()) {
                var line = sheet.createRow(rowIndex++);
                column = 0;
                line.createCell(column++).setCellValue(item.district());
                if (grouped) line.createCell(column++).setCellValue(PhoneMasker.mask(item.group()).text());
                for (var metric : overview.metrics()) line.createCell(column++).setCellValue(item.values().get(metric.key()));
            }
            sheet.setColumnWidth(0, 28 * 256);
            if (grouped) sheet.setColumnWidth(1, 24 * 256);
            sheet.createFreezePane(0, 1);
            book.write(bytes);
            return ResponseEntity.ok().contentType(MediaType.parseMediaType(
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + program + ".xlsx\"")
                    .body(bytes.toByteArray());
        }
    }
}
