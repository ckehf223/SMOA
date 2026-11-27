package com.smoa.support;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.AfterEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import com.smoa.account.Account;
import com.smoa.account.AccountRepository;
import com.smoa.permission.ActionPermission;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.permission.PackageRepository;
import com.smoa.permission.PermissionPackage;
import com.smoa.program.Program;
import com.smoa.program.ProgramRepository;

/**
 * local-memory 프로파일 전용 통합 테스트 기반. DB 드라이버·DataSource 는 이 프로파일에서 구성되지 않는다.
 * 계정·패키지·비밀번호는 모두 테스트가 만든 가상 값이며 비밀번호는 출력하지 않는다.
 * 기동 시 LocalMemoryBootstrap 이 가상 프로그램과 총관리자 시스템 패키지를 만든다(최초 계정은 없다).
 */
@SpringBootTest(properties = "smoa.security.bcrypt-strength=4")
@AutoConfigureMockMvc
@ActiveProfiles("local-memory")
public abstract class ApiTestBase {

    /** 이 JVM 안에서만 쓰는 임의 비밀번호(복잡도 규칙 충족). */
    protected static final String PASSWORD = "Aa1-" + UUID.randomUUID();
    private static final AtomicInteger SEQUENCE = new AtomicInteger();

    @Autowired
    protected MockMvc mvc;
    @Autowired
    protected AccountRepository accounts;
    @Autowired
    protected PackageRepository packages;
    @Autowired
    protected ProgramRepository programs;
    @Autowired
    protected PasswordEncoder encoder;

    @Autowired
    private com.smoa.records.memory.MemoryRecordRepository records;

    private final Map<String, Program> originalPrograms = new LinkedHashMap<>();

    /** 업무 자료는 테스트마다 비운다(계정·패키지·프로그램은 테스트가 고유 이름으로 만든다). */
    @org.junit.jupiter.api.BeforeEach
    void resetRecords() {
        records.clear();
    }

    protected void enableProgramDuringTest(String id) {
        Program program = programs.findById(id).orElseThrow();
        if (!program.active()) {
            originalPrograms.putIfAbsent(id, program);
            programs.update(program.withActive(true));
        }
    }

    @AfterEach
    void restorePrograms() {
        originalPrograms.values().forEach(programs::update);
    }

    protected TestClient client() {
        return new TestClient(mvc);
    }

    protected PermissionPackage systemPackage() {
        return packages.findAll().stream().filter(PermissionPackage::superAdmin).findFirst().orElseThrow();
    }

    protected PermissionPackage createPackage(String name, Map<String, ActionPermission> permissions, DataScope scope) {
        PermissionPackage pkg = new PermissionPackage(UUID.randomUUID().toString(), name + "-" + SEQUENCE.incrementAndGet(),
                true, false, permissions, scope);
        packages.insert(pkg);
        return pkg;
    }

    protected Account createAccount(PermissionPackage pkg) {
        String username = "user" + SEQUENCE.incrementAndGet();
        Account account = new Account(UUID.randomUUID().toString(), username, "가상 " + username, pkg.packageId(),
                encoder.encode(PASSWORD), true, 1L);
        accounts.insert(account);
        return account;
    }

    protected Account createSuperAdmin() {
        return createAccount(systemPackage());
    }

    protected TestClient loggedIn(Account account) throws Exception {
        return client().loginOk(account.username(), PASSWORD);
    }

    protected TestClient loggedInAdmin() throws Exception {
        return loggedIn(createSuperAdmin());
    }

    protected static Map<String, ActionPermission> perms(Object... pairs) {
        Map<String, ActionPermission> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], (ActionPermission) pairs[i + 1]);
        }
        return map;
    }

    protected static ActionPermission rw() {
        return new ActionPermission(true, true, true, false);
    }

    protected static ActionPermission ro() {
        return new ActionPermission(true, true, false, false);
    }

    protected static ActionPermission full() {
        return new ActionPermission(true, true, true, true);
    }

    protected static DataScope org(String... regionDistrictPairs) {
        java.util.Set<DistrictKey> keys = new java.util.LinkedHashSet<>();
        for (int i = 0; i < regionDistrictPairs.length; i += 2) {
            keys.add(new DistrictKey(regionDistrictPairs[i], regionDistrictPairs[i + 1]));
        }
        return DataScope.org(keys);
    }
}
