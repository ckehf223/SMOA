package com.smoa.analytics;

import java.util.List;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.smoa.security.CurrentAccount;

@RestController
@RequestMapping("/api/programs/dashboard")
public class AnalyticsController {
    private final AnalyticsService service;

    public AnalyticsController(AnalyticsService service) {
        this.service = service;
    }

    @GetMapping("/options")
    public List<AnalyticsService.DistrictOption> options() {
        return service.districts(CurrentAccount.require());
    }

    @GetMapping("/data/summary")
    public AnalyticsService.Dashboard summary(@RequestParam(required = false) String from,
            @RequestParam(required = false) String to, @RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode) {
        return service.dashboard(CurrentAccount.require(), from, to, regionCode, districtCode);
    }
}
