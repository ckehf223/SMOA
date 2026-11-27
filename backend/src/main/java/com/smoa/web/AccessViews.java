package com.smoa.web;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Component;

import com.smoa.access.AccessGrant;
import com.smoa.access.AccessService;
import com.smoa.account.Account;
import com.smoa.module.ModuleRegistry;
import com.smoa.module.ProgramModule;
import com.smoa.otp.OtpService;
import com.smoa.permission.ActionPermission;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.permission.PackageRepository;
import com.smoa.permission.PermissionPackage;
import com.smoa.program.Program;
import com.smoa.program.ProgramAction;
import com.smoa.program.ProgramService;
import com.smoa.reference.ReferenceRepository;
import com.smoa.web.dto.Views.AccountView;
import com.smoa.web.dto.Views.DataScopeView;
import com.smoa.web.dto.Views.DistrictInfo;
import com.smoa.web.dto.Views.DistrictView;
import com.smoa.web.dto.Views.MeResponse;
import com.smoa.web.dto.Views.MenuItem;
import com.smoa.web.dto.Views.ModuleView;
import com.smoa.web.dto.Views.PackageRef;
import com.smoa.web.dto.Views.PackageView;
import com.smoa.web.dto.Views.PermissionView;
import com.smoa.web.dto.Views.ProgramView;
import com.smoa.web.dto.Views.ReferenceView;
import com.smoa.web.dto.Views.RegionView;

/** 도메인 → 응답 DTO 변환. 권한은 프로그램 지원 동작으로 정규화한 유효 값만 내보낸다. */
@Component
public class AccessViews {

    private final AccessService access;
    private final ModuleRegistry modules;
    private final PackageRepository packages;
    private final ReferenceRepository reference;
    private final StorageInfo storage;
    private final OtpService otp;
    private final ProgramService programs;

    public AccessViews(AccessService access, ModuleRegistry modules, PackageRepository packages,
            ReferenceRepository reference, StorageInfo storage, OtpService otp, ProgramService programs) {
        this.access = access;
        this.modules = modules;
        this.packages = packages;
        this.reference = reference;
        this.storage = storage;
        this.otp = otp;
        this.programs = programs;
    }

    public MeResponse me(AccessGrant grant) {
        Account account = grant.account();
        List<Program> menu = access.menu(grant);
        var layout = programs.visibleLayout(menu);
        List<MenuItem> menus = layout.placements().stream().map(entry -> {
            Program program = grant.programs().get(entry.programId());
            return new MenuItem(program.programId(), program.name(), entry.group(), program.pagePath(), program.moduleId(),
                    program.actions().stream().sorted().map(ProgramAction::json).toList(), entry.sortOrder());
        }).toList();
        Map<String, PermissionView> permissions = new LinkedHashMap<>();
        menu.forEach(p -> permissions.put(p.programId(), permission(grant.permissions().get(p.programId()))));
        return new MeResponse(account.id(), account.username(), account.displayName(),
                new PackageRef(grant.packageId(), grant.packageName()), grant.packageActive(), grant.superAdmin(),
                menus.isEmpty(), menus, layout.groups(), permissions, scope(grant.scope()), storage.mode(), storage.devMemory());
    }

    public AccountView account(Account account) {
        String packageName = packages.findById(account.packageId()).map(PermissionPackage::name).orElse("");
        return new AccountView(account.id(), account.username(), account.displayName(), account.packageId(),
                packageName, account.active(), otp.required() && otp.enrolled(account.id()));
    }

    public PackageView pkg(PermissionPackage pkg, long accountCount) {
        Map<String, PermissionView> permissions = new LinkedHashMap<>();
        pkg.permissions().entrySet().stream().sorted(Map.Entry.comparingByKey())
                .forEach(e -> permissions.put(e.getKey(), permission(e.getValue())));
        return new PackageView(pkg.packageId(), pkg.name(), pkg.active(), pkg.superAdmin(), permissions,
                scope(pkg.scope()), accountCount);
    }

    public ProgramView program(Program p) {
        boolean connected = modules.find(p.moduleId()).map(m -> m.connectedProgramIds().contains(p.programId()))
                .orElse(false);
        return new ProgramView(p.programId(), p.name(), p.group(), p.category(), p.pagePath(), p.moduleId(),
                p.actions().stream().sorted().map(ProgramAction::json).toList(), p.superAdminOnly(), p.active(),
                p.sortOrder(), connected);
    }

    public ReferenceView reference() {
        return new ReferenceView(
                reference.regions().stream().map(r -> new RegionView(r.regionCode(), r.name(), r.active())).toList(),
                reference.districts().stream().map(d -> new DistrictInfo(d.key().regionCode(), d.key().districtCode(),
                        d.name(), d.active())).toList());
    }

    public ModuleView module(ProgramModule m) {
        return new ModuleView(m.id(), m.title(), m.frontendScript(), m.defaultProgramIds().stream().sorted().toList(),
                m.connectedProgramIds().stream().sorted().toList());
    }

    private static PermissionView permission(ActionPermission p) {
        return p == null ? new PermissionView(false, false, false, false)
                : new PermissionView(p.access(), p.read(), p.write(), p.export());
    }

    private static DataScopeView scope(DataScope scope) {
        return new DataScopeView(scope.type(), scope.districts().stream().sorted(Comparator.naturalOrder())
                .map((DistrictKey k) -> new DistrictView(k.regionCode(), k.districtCode())).toList());
    }
}
