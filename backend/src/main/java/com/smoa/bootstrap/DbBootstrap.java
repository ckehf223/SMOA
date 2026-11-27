package com.smoa.bootstrap;

import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

import com.smoa.account.Account;
import com.smoa.account.AccountRepository;
import com.smoa.account.PasswordPolicy;
import com.smoa.account.UnitOfWork;
import com.smoa.common.ApiException;
import com.smoa.config.SmoaProperties;
import com.smoa.permission.DataScope;
import com.smoa.permission.PackageRepository;
import com.smoa.permission.PermissionPackage;
import com.smoa.program.Program;
import com.smoa.program.ProgramAction;
import com.smoa.program.ProgramRepository;

/**
 * DB 모드(local/prod) 최초 총관리자 초기화. <b>기본은 비활성</b>이며 {@code smoa.bootstrap.enabled=true} 와
 * {@code smoa.bootstrap.environment}(= 활성 저장소 프로파일 이름)를 모두 명시해야 동작한다.
 * <ul>
 *   <li>USERMSTR 이 비어 있을 때만 한 트랜잭션으로 보호된 SYSTEM 패키지·없는 기본 프로그램·최초 총관리자 계정을 만든다.</li>
 *   <li>계정이 하나라도 있으면 아무 것도 쓰지 않는다(덮어쓰기 없음). 조직원 명부·대상자 등 업무 자료는 건드리지 않는다.</li>
 *   <li>비밀번호·해시는 로그에 남기지 않는다. DB 연결 실패나 계정 없음을 메모리 저장소로 대체하지 않는다.</li>
 * </ul>
 * local-memory 의 가상 초기화는 {@code LocalMemoryBootstrap} 이 따로 맡는다.
 */
@Component
@Profile({"local", "prod"})
@ConditionalOnProperty(prefix = "smoa.bootstrap", name = "enabled", havingValue = "true")
public class DbBootstrap implements ApplicationRunner {

    /** 보호된 총관리자 시스템 패키지의 고정 ID(AUTHMSTR PK). 두 인스턴스가 동시에 초기화해도 PK 충돌로 한쪽만 성공한다. */
    public static final String SYSTEM_PACKAGE_ID = "SYSTEM";
    public static final String SYSTEM_PACKAGE_NAME = "총관리자";

    private static final Logger log = LoggerFactory.getLogger(DbBootstrap.class);

    private final AccountRepository accounts;
    private final PackageRepository packages;
    private final ProgramRepository programs;
    private final PasswordEncoder encoder;
    private final UnitOfWork unitOfWork;
    private final SmoaProperties properties;
    private final Environment environment;

    public DbBootstrap(AccountRepository accounts, PackageRepository packages, ProgramRepository programs,
            PasswordEncoder encoder, UnitOfWork unitOfWork, SmoaProperties properties, Environment environment) {
        this.accounts = accounts;
        this.packages = packages;
        this.programs = programs;
        this.encoder = encoder;
        this.unitOfWork = unitOfWork;
        this.properties = properties;
        this.environment = environment;
    }

    @Override
    public void run(ApplicationArguments args) {
        SmoaProperties.Bootstrap bootstrap = properties.bootstrap();
        String active = activeStorageProfile();
        if (!active.equals(bootstrap.environment().strip())) {
            throw new IllegalStateException("smoa.bootstrap.environment(SMOA_BOOTSTRAP_ENVIRONMENT)가 활성 프로파일(" + active
                    + ")과 같아야 부트스트랩을 실행합니다. 실수로 다른 환경에서 실행되는 것을 막기 위한 확인입니다.");
        }
        String username = bootstrap.username().strip();
        String password = bootstrap.password();
        if (username.isEmpty() || password.isEmpty()) {
            throw new IllegalStateException("부트스트랩이 켜져 있지만 SMOA_BOOTSTRAP_USERNAME / SMOA_BOOTSTRAP_PASSWORD 가 비어 있습니다.");
        }
        try {
            PasswordPolicy.validateUsername(username);
            PasswordPolicy.validatePassword(username, password);
        } catch (ApiException e) {
            throw new IllegalStateException("최초 총관리자 값이 정책에 맞지 않습니다: " + e.getMessage());
        }
        boolean created;
        try {
            created = unitOfWork.execute(() -> initialize(username, password));
        } catch (DuplicateKeyException e) {
            // 다른 인스턴스가 먼저 초기화했을 수 있다. 계정이 생겼다면 정상(건너뜀), 아니면 실패로 드러낸다.
            if (accounts.count() > 0) {
                log.info("[bootstrap] 다른 프로세스가 먼저 초기화했습니다. 아무 것도 쓰지 않았습니다.");
                return;
            }
            throw e;
        }
        if (created) {
            log.info("[bootstrap] 최초 총관리자와 SYSTEM 패키지를 만들었습니다(비밀번호는 기록하지 않습니다). 확인 후 SMOA_BOOTSTRAP_ENABLED 를 끄세요.");
        } else {
            log.info("[bootstrap] 계정이 이미 있어 아무 것도 쓰지 않았습니다(덮어쓰기 없음). SMOA_BOOTSTRAP_ENABLED 를 끄세요.");
        }
    }

    private boolean initialize(String username, String password) {
        if (accounts.count() > 0) {
            return false;
        }
        PermissionPackage system = packages.findById(SYSTEM_PACKAGE_ID).orElse(null);
        if (system == null) {
            system = new PermissionPackage(SYSTEM_PACKAGE_ID, SYSTEM_PACKAGE_NAME, true, true, Map.of(), DataScope.all());
            packages.insert(system);
        } else if (!system.superAdmin() || !system.active()) {
            throw new IllegalStateException("AUTHMSTR 에 SYSTEM 패키지가 있으나 활성 총관리자 패키지가 아닙니다. 자동으로 바꾸지 않습니다. 확인이 필요합니다.");
        }
        int seeded = seedMissingPrograms();
        Account account = new Account(java.util.UUID.randomUUID().toString(), username, username, system.packageId(),
                encoder.encode(password), true, 1L);
        accounts.insert(account);
        log.info("[bootstrap] 프로그램 {}개 추가, 계정 1개 생성 target={}", seeded, account.id());
        return true;
    }

    /** PGMMSTR 에 없는 기본 프로그램만 추가한다. 같은 페이지 경로를 가진 기존 항목이 있으면 건너뛴다(기존 메뉴 보존). */
    private int seedMissingPrograms() {
        int count = 0;
        for (SmoaProperties.SeedProgram seed : properties.seedPrograms()) {
            if (programs.findById(seed.programId()).isPresent()) {
                continue;
            }
            if (seed.page() != null && programs.findByPagePath(seed.page()).isPresent()) {
                log.warn("[bootstrap] 같은 경로의 기존 프로그램이 있어 기본 프로그램을 건너뜁니다: {}", seed.programId());
                continue;
            }
            List<ProgramAction> actions = seed.actions() == null ? List.of() : seed.actions();
            Set<ProgramAction> set = actions.isEmpty() ? Set.of() : EnumSet.copyOf(actions);
            programs.insert(new Program(seed.programId(), seed.name(), seed.group() == null ? "" : seed.group(),
                    seed.category(), seed.page(), seed.module(), set, seed.superAdminOnly(), seed.active(), seed.sortOrder()));
            count++;
        }
        return count;
    }

    private String activeStorageProfile() {
        for (String profile : environment.getActiveProfiles()) {
            if (StorageProfileGuard.LOCAL.equals(profile) || StorageProfileGuard.PROD.equals(profile)) {
                return profile;
            }
        }
        return "";
    }
}
