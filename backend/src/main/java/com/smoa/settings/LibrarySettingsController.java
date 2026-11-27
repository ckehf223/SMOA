package com.smoa.settings;

import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.databind.JsonNode;
import com.smoa.common.ApiException;
import com.smoa.security.CurrentAccount;

@RestController
@RequestMapping("/api/programs/settings/data/library")
@Profile({"local", "prod"})
public class LibrarySettingsController {
    private final LibrarySettingsService settings;

    public LibrarySettingsController(LibrarySettingsService settings) {
        this.settings = settings;
    }

    @GetMapping
    public LibrarySettingsService.View read() {
        return settings.read(CurrentAccount.require());
    }

    @PutMapping
    public LibrarySettingsService.View save(@RequestBody JsonNode input) {
        var weekStart = input.path("weekStart");
        var revision = input.path("revision");
        if (!input.isObject() || input.size() != 2 || !weekStart.isIntegralNumber() || !weekStart.canConvertToInt()
                || !revision.isTextual() || revision.textValue().length() > 150) {
            throw ApiException.badRequest("INVALID_LIBRARY_SETTINGS", "주 시작 요일과 조회 정보를 확인해 주세요.");
        }
        return settings.save(CurrentAccount.require(), weekStart.intValue(), revision.textValue());
    }
}
