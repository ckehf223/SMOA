package com.smoa.calling;

import java.io.IOException;
import java.util.List;
import java.util.Map;

import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import jakarta.servlet.http.HttpSession;

import com.smoa.program.ProgramAction;
import com.smoa.security.CurrentAccount;

@RestController
@RequestMapping("/api/programs")
class CallingController {
    private static final String MANAGE = "/" + CallingService.MANAGE;
    private static final String STATS = "/" + CallingService.STATS;
    private static final MediaType XLSX = MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    private final CallingService service;
    private final CallingXlsx xlsx;
    private final CallingImportService importer;

    CallingController(CallingService service, CallingXlsx xlsx, CallingImportService importer) {
        this.service = service;
        this.xlsx = xlsx;
        this.importer = importer;
    }

    @GetMapping("/{program:callingManage|callingStats}/options")
    CallingService.Options options(@PathVariable("program") String program) {
        return service.options(CurrentAccount.require(), program);
    }

    @GetMapping({MANAGE + "/page", MANAGE + "/items"})
    CallingService.Page page(@RequestParam Map<String, String> params) {
        return service.page(CurrentAccount.require(), params);
    }

    @GetMapping("/{program:callingManage|callingStats}/summary")
    CallingStatistics.Summary summary(@PathVariable("program") String program, @RequestParam Map<String, String> params) {
        return service.summary(CurrentAccount.require(), program, params, false);
    }

    @GetMapping(MANAGE + "/targets")
    List<CallingService.Target> targets(@RequestParam(name = "q", required = false) String q) {
        return service.targets(CurrentAccount.require(), q);
    }

    @GetMapping(MANAGE + "/items/{id:[1-9][0-9]{0,19}}")
    CallingService.View find(@PathVariable("id") String id) {
        return service.find(CurrentAccount.require(), id);
    }

    @PostMapping(MANAGE + "/items")
    @ResponseStatus(HttpStatus.CREATED)
    CallingService.View create(@RequestBody CallingService.Input input) {
        return service.save(CurrentAccount.require(), null, input);
    }

    @PutMapping(MANAGE + "/items/{id:[1-9][0-9]{0,19}}")
    CallingService.View update(@PathVariable("id") String id, @RequestBody CallingService.Input input) {
        return service.save(CurrentAccount.require(), id, input);
    }

    @DeleteMapping(MANAGE + "/items/{id:[1-9][0-9]{0,19}}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void delete(@PathVariable("id") String id, @RequestParam("rowVersion") Long version) {
        service.delete(CurrentAccount.require(), id, version);
    }

    @GetMapping(MANAGE + "/export/template.xlsx")
    ResponseEntity<byte[]> template() throws IOException {
        CallingService.require(CurrentAccount.require(), CallingService.MANAGE, ProgramAction.EXPORT);
        return download("calling-template.xlsx", xlsx.template());
    }

    @GetMapping(MANAGE + "/template.xlsx")
    ResponseEntity<byte[]> inputTemplate() throws IOException {
        var grant = CurrentAccount.require();
        var action = grant.can(CallingService.MANAGE, ProgramAction.WRITE) ? ProgramAction.WRITE : ProgramAction.EXPORT;
        CallingService.require(grant, CallingService.MANAGE, action);
        return download("calling-template.xlsx", xlsx.template());
    }

    @GetMapping({MANAGE + "/export/xlsx", MANAGE + "/export/items.xlsx"})
    ResponseEntity<byte[]> export(@RequestParam Map<String, String> params) throws IOException {
        return download("calling-records.xlsx", xlsx.records(service.exportRows(CurrentAccount.require(), params)));
    }

    @GetMapping({STATS + "/export/xlsx", STATS + "/export/stats.xlsx"})
    ResponseEntity<byte[]> exportStats(@RequestParam Map<String, String> params) throws IOException {
        var summary = service.summary(CurrentAccount.require(), CallingService.STATS, params, true);
        return download("calling-statistics.xlsx", xlsx.stats(summary));
    }

    @GetMapping(MANAGE + "/export/report.xlsx")
    ResponseEntity<byte[]> exportReport(@RequestParam Map<String, String> params) throws IOException {
        var summary = service.summary(CurrentAccount.require(), CallingService.MANAGE, params, true);
        return download("calling-report.xlsx", xlsx.stats(summary));
    }

    @PostMapping(value = MANAGE + "/import/preview", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    CallingImportService.Preview previewXlsx(HttpSession session, @RequestParam("file") MultipartFile file,
            @RequestParam(name = "migration", defaultValue = "false") boolean migration) throws IOException {
        if (file.getSize() > CallingImportParser.MAX_FILE) throw CallingRules.invalid("콜링 엑셀은 1MB 이하로 선택해 주세요.");
        return importer.excel(CurrentAccount.require(), session.getId(), file.getBytes(), migration);
    }

    @PostMapping(MANAGE + "/import/report/preview")
    CallingImportService.Preview previewReport(HttpSession session, @RequestBody CallingImportService.ReportBody body) {
        return importer.report(CurrentAccount.require(), session.getId(), body);
    }

    @PostMapping(MANAGE + "/import/apply")
    CallingImportService.Applied apply(HttpSession session, @RequestBody CallingImportService.ApplyBody body) {
        return importer.apply(CurrentAccount.require(), session.getId(), body.token());
    }

    @GetMapping(MANAGE + "/export/import/{token}.xlsx")
    ResponseEntity<byte[]> convert(HttpSession session, @PathVariable("token") String token) throws IOException {
        return download("calling-report.xlsx", xlsx.reportRows(importer.convert(CurrentAccount.require(), session.getId(), token)));
    }

    private static ResponseEntity<byte[]> download(String filename, byte[] bytes) {
        return ResponseEntity.ok().contentType(XLSX)
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename(filename).build().toString())
                .body(bytes);
    }
}
