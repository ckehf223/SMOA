package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.PropertySource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.mock.env.MockEnvironment;

import com.smoa.access.AccessGrant;
import com.smoa.account.Account;
import com.smoa.account.AccountRepository;
import com.smoa.account.UnitOfWork;
import com.smoa.common.ApiException;
import com.smoa.config.SmoaProperties;
import com.smoa.crypto.ContactVault;
import com.smoa.permission.AdminMutationLock;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.records.HistoryEntry;
import com.smoa.records.Person;
import com.smoa.records.PersonField;
import com.smoa.records.RecordRepository;
import com.smoa.records.RecordsService;
import com.smoa.records.memory.MemoryRecordRepository;
import com.smoa.reference.memory.MemoryReferenceRepository;
import com.smoa.scope.ScopeEnforcer;

/** 설정 파일 계약, 관리 잠금 순서, 이력 원자성(한 UnitOfWork 안에서 현재 행·이력·CHGLOG), 연락처 키 미설정 동작. */
class PersistenceWiringTest {

    private static Object yaml(String file, String key) throws IOException {
        List<PropertySource<?>> sources = new YamlPropertySourceLoader().load(file, new ClassPathResource(file));
        for (PropertySource<?> source : sources) {
            Object raw = source.getProperty(key);
            if (raw != null) {
                return raw instanceof org.springframework.boot.origin.OriginTrackedValue t ? t.getValue() : raw;
            }
        }
        return null;
    }

    @Test
    void 설정_계약_자료실_키파일_부트스트랩_기본값과_쿠키() throws Exception {
        assertThat(yaml("application.yml", "smoa.storage.library-id")).isEqualTo("${SMOA_LIBRARY_ID:}");
        assertThat(yaml("application.yml", "smoa.contact.key-file")).isEqualTo("${SMOA_CONTACT_KEY_FILE:}");
        assertThat(yaml("application.yml", "smoa.bootstrap.enabled")).isEqualTo("${SMOA_BOOTSTRAP_ENABLED:false}");
        assertThat(yaml("application.yml", "smoa.bootstrap.environment")).isEqualTo("${SMOA_BOOTSTRAP_ENVIRONMENT:}");
        assertThat(yaml("application.yml", "mybatis.configuration.jdbc-type-for-null")).isEqualTo("NULL");
        // 기본 카탈로그에는 비활성 메뉴와 사후 프로그램 3개도 포함된다.
        int count = 0;
        while (yaml("application.yml", "smoa.seed-programs[" + count + "].program-id") != null) {
            count++;
        }
        assertThat(count).isEqualTo(29);
        // local 은 HTTP 로컬이라 명시적으로 secure=false, prod 는 true 유지
        assertThat(yaml("application-local.yml", "server.servlet.session.cookie.secure")).isEqualTo(false);
        assertThat(yaml("application-local.yml", "server.address")).isEqualTo("127.0.0.1");
        assertThat(yaml("application-prod.yml", "server.servlet.session.cookie.secure")).isEqualTo(true);
        assertThat(yaml("application.yml", "server.servlet.session.cookie.secure")).isEqualTo(true);
        // 로깅 설정: 사용자 패턴·trim 플래그 유지
        String log4jdbc = new String(new ClassPathResource("log4jdbc.log4j2.properties").getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(log4jdbc).contains("log4jdbc.trim.sql=false").contains("log4jdbc.trim.sql.extrablanklines=false")
                .contains("log4jdbc.dump.sql.maxlinelength=0").contains("RedactingSpyLogDelegator");
        assertThat(yaml("application-prod.yml", "spring.datasource.driver-class-name")).isEqualTo("org.mariadb.jdbc.Driver");
    }

    @Test
    void 관리_변경은_트랜잭션_안에서_가장_먼저_DB_행_잠금을_잡는다() {
        AccountRepository accounts = mock(AccountRepository.class);
        List<String> events = new ArrayList<>();
        UnitOfWork uow = new UnitOfWork() {
            @Override
            public <T> T execute(Supplier<T> work) {
                events.add("begin");
                try {
                    return work.get();
                } finally {
                    events.add("end");
                }
            }
        };
        org.mockito.Mockito.doAnswer(i -> events.add("row-lock")).when(accounts).lockAdminMutation();
        AdminMutationLock lock = new AdminMutationLock(uow, accounts);
        lock.run(() -> {
            events.add("work");
            return null;
        });
        assertThat(events).containsExactly("begin", "row-lock", "work", "end");
        InOrder order = inOrder(accounts);
        order.verify(accounts).lockAdminMutation();
    }

    @Test
    void 메모리_계정_저장소는_행잠금이_필요없다() {
        AccountRepository repo = new com.smoa.account.memory.MemoryAccountRepository(mock(com.smoa.permission.PackageRepository.class));
        repo.lockAdminMutation();    // 기본 구현(무동작)
        assertThat(repo.count()).isZero();
    }

    // ---- 이력 원자성 ----

    private static final class RecordingUnitOfWork implements UnitOfWork {
        boolean active;
        int executions;
        boolean committed;

        @Override
        public <T> T execute(Supplier<T> work) {
            active = true;
            executions++;
            committed = false;
            try {
                T result = work.get();
                committed = true;
                return result;
            } finally {
                active = false;
            }
        }
    }

    private static AccessGrant adminGrant() {
        Account account = new Account("acct-1", "admin", "가상관리자", "SYSTEM", "hash", true, 1);
        return new AccessGrant(account, "SYSTEM", "총관리자", true, true, Map.of(), Map.of(), DataScope.all());
    }

    @SuppressWarnings("unchecked")
    private RecordsService service(RecordRepository repository, RecordingUnitOfWork uow) {
        ObjectProvider<com.smoa.config.LibraryContext> library = mock(ObjectProvider.class);
        ContactVault vault = new ContactVault(new SmoaProperties(List.of(), null, null, null, new SmoaProperties.Contact("")),
                memoryEnvironment());
        return new RecordsService(repository, new ScopeEnforcer(new MemoryReferenceRepository()), vault, uow, library);
    }

    private static MockEnvironment memoryEnvironment() {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("local-memory");
        return env;
    }

    @Test
    void 단계_이동은_현재_행_변경과_단계_이력과_변경이력을_하나의_트랜잭션에서_기록한다() {
        MemoryRecordRepository inner = new MemoryRecordRepository();
        RecordingUnitOfWork uow = new RecordingUnitOfWork();
        List<String> calls = new ArrayList<>();
        RecordRepository spy = new RecordRepositoryProxy(inner, uow, calls);
        RecordsService service = service(spy, uow);
        Person created = service.createPerson(adminGrant(), baseBody());
        calls.clear();
        service.changeStage(adminGrant(), created.id(), "콜링", "2026-01-05", "09:30", "사유", created.rowVersion());
        assertThat(calls).containsExactly("updatePerson@tx", "appendHistory:STAGE@tx", "appendHistory:CHANGE@tx");
        assertThat(uow.executions).isEqualTo(2);       // 생성 1회 + 단계 이동 1회
    }

    @Test
    void 이력_기록이_실패하면_예외가_전파되어_트랜잭션이_커밋되지_않는다() {
        MemoryRecordRepository inner = new MemoryRecordRepository();
        RecordingUnitOfWork uow = new RecordingUnitOfWork();
        List<String> calls = new ArrayList<>();
        RecordRepositoryProxy failing = new RecordRepositoryProxy(inner, uow, calls);
        RecordsService service = service(failing, uow);
        Person created = service.createPerson(adminGrant(), baseBody());
        failing.failOnHistoryKind = HistoryEntry.KIND_CHANGE;
        assertThatThrownBy(() -> service.changeStage(adminGrant(), created.id(), "콜링", "2026-01-05", null, null, created.rowVersion()))
                .isInstanceOf(IllegalStateException.class);
        assertThat(uow.committed).isFalse();       // DB 구현에서는 이 예외로 TransactionTemplate 이 롤백한다
        assertThat(uow.active).isFalse();
    }

    @Test
    void 연락처_키가_없으면_연락처_저장은_503_으로_명시_실패하고_원문_대체가_없다() {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("local");
        ContactVault noKey = new ContactVault(new SmoaProperties(List.of(), null, null, null, new SmoaProperties.Contact("")), env);
        assertThat(noKey.available()).isFalse();
        assertThatThrownBy(() -> noKey.seal("010-1234-5678", "aad")).isInstanceOfSatisfying(ApiException.class,
                e -> {
                    assertThat(e.status().value()).isEqualTo(503);
                    assertThat(e.code()).isEqualTo("CONTACT_KEY_UNAVAILABLE");
                    assertThat(e.getMessage()).doesNotContain("1234");
                });
        // 키 파일이 설정되었는데 읽을 수 없으면 기동 단계에서 실패
        assertThatThrownBy(() -> new ContactVault(new SmoaProperties(List.of(), null, null, null,
                new SmoaProperties.Contact("Z:/does/not/exist.key")), env)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("SMOA_CONTACT_KEY_FILE");
    }

    @Test
    void local_memory_는_파일이_없으면_임의_키로_동작한다() {
        ContactVault vault = new ContactVault(new SmoaProperties(List.of(), null, null, null, new SmoaProperties.Contact("")),
                memoryEnvironment());
        assertThat(vault.available()).isTrue();
        assertThat(vault.ephemeralKey()).isTrue();
        assertThat(vault.seal("010-1234-5678", "SMOA:v1:memory:TGMSTR:db:1:PHONE_ENC").last4()).isEqualTo("5678");
    }

    @Test
    @SuppressWarnings("unchecked")
    void 이관_행의_Node_봉투는_MIGMAP_원본_ID_기준_AAD_로만_열린다(@org.junit.jupiter.api.io.TempDir java.nio.file.Path dir) throws Exception {
        com.fasterxml.jackson.databind.JsonNode fixture;
        try (java.io.InputStream in = getClass().getResourceAsStream("/crypto/contact-envelope-fixture.json")) {
            fixture = new com.fasterxml.jackson.databind.ObjectMapper().readTree(in);
        }
        java.nio.file.Path keyFile = dir.resolve("synthetic.key");
        java.nio.file.Files.write(keyFile, java.util.HexFormat.of().parseHex(fixture.get("keyHex").asText()));
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("local");
        ContactVault vault = new ContactVault(new SmoaProperties(List.of(), null, null, null, new SmoaProperties.Contact(keyFile.toString())), env);
        assertThat(vault.available()).isTrue();

        RecordRepository repository = mock(RecordRepository.class);
        org.mockito.Mockito.when(repository.migrationSourceId("42")).thenReturn(java.util.Optional.of("person-src-1"));
        org.mockito.Mockito.when(repository.migrationSourceId("43")).thenReturn(java.util.Optional.empty());
        ObjectProvider<com.smoa.config.LibraryContext> library = mock(ObjectProvider.class);
        org.mockito.Mockito.when(library.getIfAvailable()).thenReturn(new com.smoa.config.LibraryContext(
                new SmoaProperties(List.of(), null, null, new SmoaProperties.Storage(fixture.get("library").asText()), null)));
        RecordsService service = new RecordsService(repository, new ScopeEnforcer(new MemoryReferenceRepository()), vault,
                new RecordingUnitOfWork(), library);

        String migrated = fixture.get("cases").get(0).get("envelope").asText();
        String webSealed = fixture.get("cases").get(1).get("envelope").asText();
        // 42 번은 이관 행: 원본 ID(person-src-1) 기준 AAD 로 열린다. 웹 AAD(db:42) 도 후보지만 이 봉투는 이관 AAD 이다.
        assertThat(vault.openForVerification(migrated, service.phoneAadCandidates("42"))).isEqualTo("010-0000-1234");
        assertThat(vault.openForVerification(webSealed, service.phoneAadCandidates("42"))).isEqualTo("+82 10 0000 5678");
        // 43 번은 MIGMAP 에 없다: 이관 봉투(다른 레코드의 것)는 열리지 않는다
        assertThatThrownBy(() -> vault.openForVerification(migrated, service.phoneAadCandidates("43")))
                .isInstanceOf(com.smoa.crypto.ContactCrypto.ContactCryptoException.class);
        assertThat(service.phoneAadCandidates("43")).containsExactly("SMOA:v1:lib-synthetic:TGMSTR:db:43:PHONE_ENC");
    }

    private static Map<String, Object> baseBody() {
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("name", "가상인");
        body.put("regionCode", "R1");
        body.put("districtCode", "D1");
        body.put("stageId", "찾B");
        return body;
    }

    @Test
    void 구역이_없는_ORG_범위_행은_가시성_판정에서_거부된다() {
        ScopeEnforcer enforcer = new ScopeEnforcer(new MemoryReferenceRepository());
        Account account = new Account("a", "u", "n", "p", "h", true, 1);
        AccessGrant org = new AccessGrant(account, "p", "p", true, false, Map.of(), Map.of(), DataScope.org(List.of(new DistrictKey("R1", "D1"))));
        AccessGrant all = new AccessGrant(account, "p", "p", true, false, Map.of(), Map.of(), DataScope.all());
        assertThat(enforcer.visible(org, null)).isFalse();
        assertThat(enforcer.visible(all, null)).isTrue();
        assertThat(enforcer.visibility(org).test(null)).isFalse();
        assertThat(enforcer.visibility(all).test(null)).isTrue();
        assertThat(enforcer.visibility(all).test(new DistrictKey("R1", "D8"))).isFalse();     // 비활성 구역
        assertThat(enforcer.visibility(org).test(new DistrictKey("R1", "D1"))).isTrue();
        assertThat(enforcer.visibility(org).test(new DistrictKey("R2", "D1"))).isFalse();     // 같은 구역 코드, 다른 지역
        assertThat(enforcer.visibility(new AccessGrant(account, "p", "p", true, false, Map.of(), Map.of(), DataScope.none()))
                .test(new DistrictKey("R1", "D1"))).isFalse();
    }

    /** 저장소 호출이 UnitOfWork 안에서 일어나는지 기록하고, 지정한 이력 종류에서 실패를 흉내 낸다. */
    private static final class RecordRepositoryProxy implements RecordRepository {
        private final MemoryRecordRepository inner;
        private final RecordingUnitOfWork uow;
        private final List<String> calls;
        String failOnHistoryKind;

        RecordRepositoryProxy(MemoryRecordRepository inner, RecordingUnitOfWork uow, List<String> calls) {
            this.inner = inner;
            this.uow = uow;
            this.calls = calls;
        }

        private String tx(String name) {
            return name + (uow.active ? "@tx" : "@NO-TX");
        }

        @Override
        public Map<String, List<CodeItem>> codes() {
            return inner.codes();
        }

        @Override
        public boolean employeeExists(String employeeId, DataScope scope) {
            return inner.employeeExists(employeeId, scope);
        }

        @Override
        public List<Person> searchPeople(PeopleQuery query, DataScope scope) {
            return inner.searchPeople(query, scope);
        }

        @Override
        public java.util.Optional<Person> findPerson(String id, DataScope scope) {
            return inner.findPerson(id, scope);
        }

        @Override
        public Person insertPerson(Person person) {
            calls.add(tx("insertPerson"));
            return inner.insertPerson(person);
        }

        @Override
        public WriteResult<Person> updatePerson(String id, Map<PersonField, Object> changes, PhoneUpdate phone, long expectedVersion,
                DataScope scope) {
            calls.add(tx("updatePerson"));
            return inner.updatePerson(id, changes, phone, expectedVersion, scope);
        }

        @Override
        public void attachInitialPhone(String id, ContactVault.PhoneSecret secret) {
            inner.attachInitialPhone(id, secret);
        }

        @Override
        public java.util.Optional<String> migrationSourceId(String personId) {
            return inner.migrationSourceId(personId);
        }

        @Override
        public List<com.smoa.records.Activity> searchActivities(ActivityQuery query, DataScope scope) {
            return inner.searchActivities(query, scope);
        }

        @Override
        public java.util.Optional<com.smoa.records.Activity> findActivity(String id, DataScope scope) {
            return inner.findActivity(id, scope);
        }

        @Override
        public com.smoa.records.Activity insertActivity(com.smoa.records.Activity activity) {
            return inner.insertActivity(activity);
        }

        @Override
        public WriteResult<com.smoa.records.Activity> updateActivity(String id, Map<com.smoa.records.ActivityField, Object> changes,
                long expectedVersion, DataScope scope) {
            return inner.updateActivity(id, changes, expectedVersion, scope);
        }

        @Override
        public void appendHistory(HistoryEntry entry, String beforeJson, String afterJson) {
            calls.add(tx("appendHistory:" + entry.kind()));
            if (entry.kind().equals(failOnHistoryKind)) {
                throw new IllegalStateException("simulated history failure");
            }
            inner.appendHistory(entry, beforeJson, afterJson);
        }

        @Override
        public HistoryPage history(HistoryQuery query, DataScope scope) {
            return inner.history(query, scope);
        }

        @Override
        public Map<String, Long> stageTransitions(StageQuery query, DataScope scope) {
            return inner.stageTransitions(query, scope);
        }

        @Override
        public long countPeople(PeopleQuery query, DataScope scope) {
            return inner.countPeople(query, scope);
        }

        @Override
        public long countActivities(ActivityQuery query, DataScope scope) {
            return inner.countActivities(query, scope);
        }

        @Override
        public ActivityTotals summarizeActivities(ActivityQuery query, DataScope scope) {
            return inner.summarizeActivities(query, scope);
        }

        @Override
        public EmployeePage searchEmployees(String q, DataScope scope, int limit) {
            return inner.searchEmployees(q, scope, limit);
        }
    }
}
