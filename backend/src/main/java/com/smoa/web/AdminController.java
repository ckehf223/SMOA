package com.smoa.web;

import java.util.List;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.smoa.access.AccessGrant;
import com.smoa.account.AccountAdminService;
import com.smoa.account.AccountAdminService.CreateCommand;
import com.smoa.account.AccountAdminService.UpdateCommand;
import com.smoa.module.ModuleRegistry;
import com.smoa.permission.PackageService;
import com.smoa.permission.PermissionPolicy;
import com.smoa.program.ProgramService;
import com.smoa.reference.ReferenceRepository;
import com.smoa.web.dto.Requests.CreateAccountRequest;
import com.smoa.web.dto.Requests.CreatePackageRequest;
import com.smoa.web.dto.Requests.RegisterProgramRequest;
import com.smoa.web.dto.Requests.ResetPasswordRequest;
import com.smoa.web.dto.Requests.UpdateAccountRequest;
import com.smoa.web.dto.Requests.UpdatePackageRequest;
import com.smoa.web.dto.Requests.UpdateProgramRequest;
import com.smoa.web.dto.Views.AccountView;
import com.smoa.web.dto.Views.ModuleView;
import com.smoa.web.dto.Views.PackageView;
import com.smoa.web.dto.Views.ProgramView;
import com.smoa.web.dto.Views.ReferenceView;

import jakarta.validation.Valid;

/**
 * 총관리자 전용 관리 API(identity/access 모듈): 프로그램·권한 패키지·계정·기준 정보. 보안 필터와 각 메서드에서
 * 각각 총관리자 시스템 패키지 여부를 확인한다. 회원가입 API 는 없다.
 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {

    private final ProgramService programs;
    private final PackageService packages;
    private final AccountAdminService accounts;
    private final PermissionPolicy policy;
    private final AccessViews views;
    private final ModuleRegistry modules;
    private final ReferenceRepository reference;

    public AdminController(ProgramService programs, PackageService packages, AccountAdminService accounts,
            PermissionPolicy policy, AccessViews views, ModuleRegistry modules, ReferenceRepository reference) {
        this.programs = programs;
        this.packages = packages;
        this.accounts = accounts;
        this.policy = policy;
        this.views = views;
        this.modules = modules;
        this.reference = reference;
    }

    // ---- 기준 정보 ----

    @GetMapping("/modules")
    public List<ModuleView> modules() {
        AdminGuard.superAdmin();
        return modules.all().stream().map(views::module).toList();
    }

    @GetMapping("/reference")
    public ReferenceView reference() {
        AdminGuard.superAdmin();
        return views.reference();
    }

    // ---- 프로그램 ----

    @GetMapping("/programs")
    public List<ProgramView> listPrograms() {
        AdminGuard.superAdmin();
        return programs.list().stream().map(views::program).toList();
    }

    @PostMapping("/programs")
    @ResponseStatus(HttpStatus.CREATED)
    public ProgramView registerProgram(@Valid @RequestBody RegisterProgramRequest r) {
        AdminGuard.superAdmin();
        return views.program(programs.register(new ProgramService.Command(r.programId(), r.name(), r.group(),
                r.category(), r.pagePath(), r.moduleId(), r.actions(), r.superAdminOnly(), r.active(),
                r.sortOrder())));
    }

    @PatchMapping("/programs/{programId}")
    public ProgramView updateProgram(@PathVariable String programId, @Valid @RequestBody UpdateProgramRequest r) {
        AdminGuard.superAdmin();
        return views.program(programs.update(programId, new ProgramService.Command(null, r.name(), r.group(),
                r.category(), r.pagePath(), r.moduleId(), r.actions(), null, r.active(), r.sortOrder())));
    }

    // ---- 권한 패키지 ----

    @GetMapping("/packages")
    public List<PackageView> listPackages() {
        AdminGuard.superAdmin();
        return packages.list().stream().map(p -> views.pkg(p, packages.accountCount(p.packageId()))).toList();
    }

    @GetMapping("/packages/{packageId}")
    public PackageView getPackage(@PathVariable String packageId) {
        AdminGuard.superAdmin();
        return views.pkg(packages.get(packageId), packages.accountCount(packageId));
    }

    @PostMapping("/packages")
    @ResponseStatus(HttpStatus.CREATED)
    public PackageView createPackage(@Valid @RequestBody CreatePackageRequest r) {
        AdminGuard.superAdmin();
        var created = packages.create(new PackageService.Command(r.name(), r.active(),
                AdminGuard.permissions(r.permissions()), AdminGuard.scope(policy, r.dataScope())));
        return views.pkg(created, 0);
    }

    @PatchMapping("/packages/{packageId}")
    public PackageView updatePackage(@PathVariable String packageId, @Valid @RequestBody UpdatePackageRequest r) {
        AdminGuard.superAdmin();
        var updated = packages.update(packageId, new PackageService.Command(r.name(), r.active(),
                AdminGuard.permissions(r.permissions()), AdminGuard.scope(policy, r.dataScope())));
        return views.pkg(updated, packages.accountCount(packageId));
    }

    @DeleteMapping("/packages/{packageId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deletePackage(@PathVariable String packageId) {
        AdminGuard.superAdmin();
        packages.delete(packageId);
    }

    // ---- 계정 ----

    @GetMapping("/accounts")
    public List<AccountView> listAccounts() {
        AccessGrant actor = AdminGuard.superAdmin();
        return accounts.list(actor).stream().map(views::account).toList();
    }

    @GetMapping("/accounts/{id}")
    public AccountView getAccount(@PathVariable String id) {
        AccessGrant actor = AdminGuard.superAdmin();
        return views.account(accounts.get(actor, id));
    }

    @PostMapping("/accounts")
    @ResponseStatus(HttpStatus.CREATED)
    public AccountView createAccount(@Valid @RequestBody CreateAccountRequest r) {
        AccessGrant actor = AdminGuard.superAdmin();
        return views.account(accounts.create(actor,
                new CreateCommand(r.username(), r.displayName(), r.password(), r.packageId(), r.active())));
    }

    @PatchMapping("/accounts/{id}")
    public AccountView updateAccount(@PathVariable String id, @Valid @RequestBody UpdateAccountRequest r) {
        AccessGrant actor = AdminGuard.superAdmin();
        return views.account(accounts.update(actor, id, new UpdateCommand(r.displayName(), r.active(), r.packageId())));
    }

    @PutMapping("/accounts/{id}/password")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void resetPassword(@PathVariable String id, @Valid @RequestBody ResetPasswordRequest r) {
        AccessGrant actor = AdminGuard.superAdmin();
        accounts.resetPassword(actor, id, r.newPassword());
    }
}
