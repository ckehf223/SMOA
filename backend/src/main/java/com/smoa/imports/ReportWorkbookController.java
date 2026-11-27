package com.smoa.imports;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.smoa.security.CurrentAccount;

import jakarta.validation.Valid;

@RestController
@RequestMapping("/api/programs")
public class ReportWorkbookController {

    private static final MediaType XLSX = MediaType.parseMediaType(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    private final ReportWorkbookService reports;

    public ReportWorkbookController(ReportWorkbookService reports) {
        this.reports = reports;
    }

    @GetMapping("/daily/options")
    public List<ReportWorkbookService.DistrictOption> districts() {
        return reports.districts(CurrentAccount.require());
    }

    @GetMapping("/reports/templates")
    public List<Map<String, String>> templates() {
        return reports.templates();
    }

    @GetMapping("/reports/export/{template}.xlsx")
    public ResponseEntity<byte[]> template(@PathVariable String template) throws IOException {
        return download(reports.template(template), template + ".xlsx");
    }

    @PostMapping("/daily/export/conversion.xlsx")
    public ResponseEntity<byte[]> conversion(@RequestBody @Valid ReportWorkbookService.Conversion body) throws IOException {
        return download(reports.conversion(CurrentAccount.require(), body), "구역일보-변환.xlsx");
    }

    private static ResponseEntity<byte[]> download(byte[] body, String filename) {
        return ResponseEntity.ok().contentType(XLSX).header(HttpHeaders.CONTENT_DISPOSITION,
                ContentDisposition.attachment().filename(filename, StandardCharsets.UTF_8).build().toString()).body(body);
    }
}
