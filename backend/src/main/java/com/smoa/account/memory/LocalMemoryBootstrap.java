package com.smoa.account.memory;

import java.util.EnumSet;
import java.util.List;
import java.util.Set;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import com.smoa.account.AccountAdminService;
import com.smoa.config.SmoaProperties;
import com.smoa.permission.PackageRepository;
import com.smoa.permission.PackageService;
import com.smoa.permission.PermissionPackage;
import com.smoa.program.Program;
import com.smoa.program.ProgramAction;
import com.smoa.program.ProgramRepository;

/**
 * local-memory 기동 초기화: (1) 가상 프로그램 시드, (2) 보호된 총관리자 시스템 패키지, (3) 환경 변수로 지정한 최초 총관리자 계정.
 * 계정은 환경 변수 SMOA_BOOTSTRAP_USERNAME / SMOA_BOOTSTRAP_PASSWORD 로만 만든다. 기본 공용 비밀번호는 없다.
 * 운영(local/prod)에서는 이 빈이 없으며 가상 자료가 들어가지 않는다.
 */
@Component
@Profile("local-memory")
public class LocalMemoryBootstrap implements ApplicationRunner {

    public static final String SYSTEM_PACKAGE_NAME = "총관리자";

    private static final Logger log = LoggerFactory.getLogger(LocalMemoryBootstrap.class);

    private final AccountAdminService accounts;
    private final PackageService packageService;
    private final PackageRepository packages;
    private final ProgramRepository programs;
    private final SmoaProperties properties;

    public LocalMemoryBootstrap(AccountAdminService accounts, PackageService packageService,
            PackageRepository packages, ProgramRepository programs, SmoaProperties properties,
            Environment environment) {
        this.accounts = accounts;
        this.packageService = packageService;
        this.packages = packages;
        this.programs = programs;
        this.properties = properties;
        String address = environment.getProperty("server.address");
        if (!"127.0.0.1".equals(address)) {
            throw new IllegalStateException("local-memory 모드는 127.0.0.1 에만 바인딩할 수 있습니다(server.address=" + address + ").");
        }
    }

    @Override
    public void run(ApplicationArguments args) {
        log.warn("[local-memory] 가상 자료 전용 메모리 모드입니다. 서버를 종료하면 모든 계정·패키지·프로그램·업무 자료가 사라집니다. "
                + "실제 자료·연락처·운영 비밀번호를 입력하지 마세요. DB 에는 연결하지 않습니다.");
        seedPrograms();
        PermissionPackage system = packages.findAll().stream().filter(PermissionPackage::superAdmin).findFirst()
                .orElseGet(() -> packageService.createSystemPackage(SYSTEM_PACKAGE_NAME));
        SmoaProperties.Bootstrap bootstrap = properties.bootstrap();
        boolean hasUser = !bootstrap.username().isBlank();
        boolean hasPassword = !bootstrap.password().isBlank();
        if (hasUser && hasPassword) {
            accounts.bootstrapSuperAdmin(bootstrap.username().strip(), bootstrap.password(), system.packageId());
            log.info("[local-memory] 최초 총관리자를 환경 변수 값으로 만들었습니다.");
        } else if (hasUser || hasPassword) {
            throw new IllegalStateException(
                    "SMOA_BOOTSTRAP_USERNAME 과 SMOA_BOOTSTRAP_PASSWORD 는 함께 지정해야 합니다.");
        } else {
            log.warn("[local-memory] SMOA_BOOTSTRAP_USERNAME/SMOA_BOOTSTRAP_PASSWORD 가 없어 계정이 없습니다. 로그인할 수 없습니다.");
        }
    }

    private void seedPrograms() {
        for (SmoaProperties.SeedProgram seed : properties.seedPrograms()) {
            if (programs.findById(seed.programId()).isPresent()) {
                continue;
            }
            List<ProgramAction> actions = seed.actions() == null ? List.of() : seed.actions();
            Set<ProgramAction> set = actions.isEmpty() ? Set.of() : EnumSet.copyOf(actions);
            programs.insert(new Program(seed.programId(), seed.name(), seed.group() == null ? "" : seed.group(),
                    seed.category(), seed.page(), seed.module(), set, seed.superAdminOnly(), seed.active(), seed.sortOrder()));
        }
    }
}
