package com.smoa.web;

import java.util.List;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import com.smoa.program.MenuLayout;
import com.smoa.program.ProgramService;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

@RestController
public final class MenuLayoutController {

    private final ProgramService programs;
    private final AccessViews views;

    public MenuLayoutController(ProgramService programs, AccessViews views) {
        this.programs = programs;
        this.views = views;
    }

    public record Entry(@NotBlank @Size(max = 64) String programId, @Size(max = 30) String group,
            @NotNull @Min(0) @Max(100000) Integer sortOrder, @Size(max = 50) String name) {
    }

    public record Folder(@NotBlank @Size(max = 30) String path, @NotNull @Min(0) @Max(100000) Integer sortOrder) {
    }

    public record Layout(@NotNull @Size(min = 1, max = 1000) List<@NotNull @Valid Entry> placements,
            @Size(max = 1000) List<@NotNull @Valid Folder> groups) {
    }

    @GetMapping("/api/admin/menu-layout")
    public MenuLayout read() {
        AdminGuard.superAdmin();
        return programs.menuLayout();
    }

    @PatchMapping("/api/admin/menu-layout")
    public Object update(@Valid @RequestBody Layout request) {
        AdminGuard.superAdmin();
        var placements = request.placements().stream()
                .map(entry -> new ProgramService.Placement(entry.programId(), entry.group(), entry.sortOrder(), entry.name()))
                .toList();
        var groups = request.groups() == null ? null : request.groups().stream()
                .map(folder -> new MenuLayout.Group(folder.path(), folder.sortOrder())).toList();
        var updated = programs.updateLayout(placements, groups);
        return groups == null ? updated.programs().stream().map(views::program).toList() : updated.layout();
    }
}
