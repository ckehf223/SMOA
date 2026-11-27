package com.smoa.afterreport;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.smoa.afterreport.AfterReportData.Analysis;
import com.smoa.afterreport.AfterReportData.Options;
import com.smoa.afterreport.AfterReportData.Page;
import com.smoa.afterreport.AfterReportData.Report;
import com.smoa.afterreport.AfterReportData.Submission;
import com.smoa.security.CurrentAccount;

@RestController
@RequestMapping("/api/programs/{programId:afterAll|afterOrganizer|afterParticipant}")
public class AfterReportController {
    private final AfterReportService service;

    public AfterReportController(AfterReportService service) {
        this.service = service;
    }

    @GetMapping("/options")
    public Options options(@PathVariable String programId) {
        return service.options(CurrentAccount.require(), programId);
    }

    @GetMapping("/page")
    public Page page(@PathVariable String programId, @RequestParam(required = false) String from,
            @RequestParam(required = false) String to, @RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode, @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "50") int size) {
        return service.page(CurrentAccount.require(), programId, from, to, regionCode, districtCode, page, size);
    }

    @GetMapping("/analysis")
    public Analysis analysis(@PathVariable String programId, @RequestParam(required = false) String from,
            @RequestParam(required = false) String to, @RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode) {
        return service.analysis(CurrentAccount.require(), programId, from, to, regionCode, districtCode);
    }

    @PostMapping("/items")
    public Report save(@PathVariable String programId, @RequestBody Submission body) {
        return service.save(CurrentAccount.require(), programId, body);
    }
}
