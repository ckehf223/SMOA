package com.smoa.analysis;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.List;

import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.smoa.program.ProgramAction;
import com.smoa.security.CurrentAccount;

@RestController
@RequestMapping("/api/programs")
public class AnalysisController {
    private final AnalysisService service;

    AnalysisController(AnalysisService service) {
        this.service = service;
    }

    @GetMapping("/findingStats/options")
    public List<AnalysisService.DistrictOption> findingOptions() {
        return service.districts(CurrentAccount.require(), AnalysisService.FINDINGS);
    }

    @GetMapping("/findingStats/data/summary")
    public FindingAnalysis.Summary finding(@RequestParam(required = false) String from,
            @RequestParam(required = false) String to, @RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode, @RequestParam(required = false) String job) {
        return service.finding(CurrentAccount.require(), from, to, regionCode, districtCode, job);
    }

    @GetMapping("/findingStats/export/summary.xlsx")
    public ResponseEntity<byte[]> findingExport(@RequestParam(required = false) String from,
            @RequestParam(required = false) String to, @RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode, @RequestParam(required = false) String job) throws IOException {
        var grant = CurrentAccount.require();
        AnalysisService.require(grant, AnalysisService.FINDINGS, ProgramAction.EXPORT);
        var result = service.finding(grant, from, to, regionCode, districtCode, job);
        try (var book = new XSSFWorkbook()) {
            var summary = book.createSheet("요약");
            row(summary, "기간 내 노방 찾기", result.total());
            row(summary, "주관 구간 연결", result.linked());
            row(summary, "직업 조건 내 연결", result.selectedLinked());
            row(summary, "시각 미입력", result.gaps().missingTime());
            row(summary, "구역 미입력", result.gaps().missingDistrict());
            row(summary, "주관 구간 없음", result.gaps().noSession());
            row(summary, "둘 이상의 주관자", result.gaps().ambiguous());
            var dates = book.createSheet("일자별");
            row(dates, "날짜", "찾기", "시각 미입력");
            result.days().forEach(day -> row(dates, day.date(), day.total(), day.missingTime()));
            var hours = book.createSheet("시간대별");
            row(hours, "시간대", "찾기", "직업 조건 내 주관 연결");
            result.hours().forEach(hour -> row(hours, hour.hour(), hour.total(), hour.linked()));
            var leaders = book.createSheet("주관자별");
            row(leaders, "주관자", "직업구분 코드", "주관구간", "순주관시간(분)", "시간대 찾기", "시간당 찾기", "회차 미확정");
            var sessions = book.createSheet("주관 구간");
            row(sessions, "주관자", "구역", "시작", "종료", "분", "연결 찾기");
            result.leaders().forEach(leader -> {
                row(leaders, leader.name(), leader.jobCode(), leader.sessions().size(), leader.minutes(), leader.linked(),
                        leader.efficiency(), leader.uncertainSessions());
                leader.sessions().forEach(session -> row(sessions, leader.name(), session.district(), session.start(),
                        session.end(), session.minutes(), session.linked()));
            });
            return workbook(book, "findingStats.xlsx");
        }
    }

    @GetMapping("/diagnostics/options")
    public List<AnalysisService.DistrictOption> diagnosticOptions() {
        return service.districts(CurrentAccount.require(), AnalysisService.DIAGNOSTICS);
    }

    @GetMapping("/diagnostics/data/summary")
    public DiagnosticsAnalysis.Summary diagnostics(@RequestParam(required = false) String anchor,
            @RequestParam(required = false) String kind, @RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode) {
        return service.diagnostics(CurrentAccount.require(), anchor, kind, regionCode, districtCode);
    }

    @GetMapping("/diagnostics/export/summary.xlsx")
    public ResponseEntity<byte[]> diagnosticsExport(@RequestParam(required = false) String anchor,
            @RequestParam(required = false) String kind, @RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode) throws IOException {
        var grant = CurrentAccount.require();
        AnalysisService.require(grant, AnalysisService.DIAGNOSTICS, ProgramAction.EXPORT);
        var result = service.diagnostics(grant, anchor, kind, regionCode, districtCode);
        try (var book = new XSSFWorkbook()) {
            var periods = book.createSheet("기간 비교");
            row(periods, "시작", "종료", "노방 찾기", "노방 활동", "찾기 시각 누락", "찾기 장소 누락", "활동 시각 누락", "활동 장소 누락", "활동자 누락");
            var cohorts = book.createSheet("단계");
            row(cohorts, "시작", "종료", "단계", "기준 일수", "전체", "기간 내 도달", "관찰 완료", "관찰 중", "도달 비율");
            for (var summary : result.periods()) {
                var period = summary.period();
                var quality = summary.quality();
                row(periods, period.from(), period.to(), summary.roadFindings(), summary.roadActivities(), quality.findingsWithoutTime(),
                        quality.findingsWithoutPlace(), quality.activitiesWithoutTime(), quality.activitiesWithoutPlace(), quality.activitiesWithoutWorker());
                summary.cohorts().forEach(cohort -> row(cohorts, period.from(), period.to(), cohort.label(), cohort.days(),
                        cohort.started(), cohort.reached(), cohort.completed(), cohort.observing(), cohort.rate()));
            }
            var places = book.createSheet("장소·시간대");
            row(places, "구역", "장소", "시간대", "활동 기록", "활동자", "인분", "찾기");
            result.locations().forEach(place -> row(places, place.district(), place.place(), place.hour(), place.records(),
                    place.workers(), place.minutes(), place.findings()));
            return workbook(book, "diagnostics.xlsx");
        }
    }

    private static void row(Sheet sheet, Object... values) {
        var row = sheet.createRow(sheet.getPhysicalNumberOfRows());
        for (int i = 0; i < values.length; i++) {
            Object v = values[i];
            if (v == null) continue;
            if (v instanceof Number number) row.createCell(i).setCellValue(number.doubleValue());
            else row.createCell(i).setCellValue(v.toString());
        }
    }

    private static ResponseEntity<byte[]> workbook(XSSFWorkbook book, String name) throws IOException {
        var bytes = new ByteArrayOutputStream();
        book.write(bytes);
        return ResponseEntity.ok().header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename(name).build().toString())
                .contentType(MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
                .body(bytes.toByteArray());
    }
}
