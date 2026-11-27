package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.stream.Stream;

import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.context.ConfigurableApplicationContext;

import com.smoa.bootstrap.StorageProfileGuard.StorageProfileException;

/**
 * 프로파일 미지정 / 미완료 Mapper 계약이면 기동이 실패하고 메모리 모드로 대체되지 않음을 검증한다.
 * 어떤 경우에도 DB 에 연결하지 않는다: 프로파일 검사는 컨텍스트 생성 전에 실패하고, local/prod 의 계약 검사는
 * SqlSessionFactory 설정만 확인한다. 접속 정보는 build.gradle 의 test 환경 변수(예약 도메인 db.invalid·더미 값)이며
 * Hikari 는 첫 getConnection 에서 연결하므로 연결 시도 자체가 일어나지 않는다.
 */
class StartupContractTest {

    private static ConfigurableApplicationContext run(String... args) {
        SpringApplication application = new SpringApplication(SmoaApplication.class);
        application.setWebApplicationType(WebApplicationType.SERVLET);
        String[] all = Stream.concat(Stream.of("--spring.main.banner-mode=off", "--server.port=0"), Stream.of(args)).toArray(String[]::new);
        return application.run(all);
    }

    private static Throwable rootCause(Throwable t) {
        while (t.getCause() != null) {
            t = t.getCause();
        }
        return t;
    }

    @Test
    void 프로파일을_지정하지_않으면_기동_실패한다() {
        assertThatThrownBy(() -> run()).isInstanceOf(StorageProfileException.class)
                .hasMessageContaining("프로파일").hasMessageContaining("메모리 모드로 자동 전환하지 않습니다");
    }

    @Test
    void 저장소와_무관한_프로파일만_지정해도_실패한다() {
        assertThatThrownBy(() -> run("--spring.profiles.active=test-fixture")).isInstanceOf(StorageProfileException.class);
    }

    @Test
    void 저장소_프로파일을_둘_이상_지정하면_실패한다() {
        assertThatThrownBy(() -> run("--spring.profiles.active=local-memory,local")).isInstanceOf(StorageProfileException.class);
        assertThatThrownBy(() -> run("--spring.profiles.active=local,prod")).isInstanceOf(StorageProfileException.class);
    }

    @Test
    void local_프로파일은_자료실ID가_없으면_DB_연결_전에_실패하고_자동선택_또는_메모리로_대체하지_않는다() {
        // Mapper 계약(identity/reference/records)은 실제 XML 로 연결되었으므로 이제 자료실 ID 명시가 첫 번째 시작 조건이다.
        assertThatThrownBy(() -> run("--spring.profiles.active=local")).satisfies(e -> {
            Throwable root = rootCause(e);
            assertThat(root).isInstanceOf(IllegalStateException.class);
            assertThat(root.getMessage()).contains("SMOA_LIBRARY_ID", "자동으로 선택하지 않습니다");
        });
    }

    @Test
    void prod_프로파일도_자료실ID가_없으면_실패한다() {
        assertThatThrownBy(() -> run("--spring.profiles.active=prod")).satisfies(e -> {
            Throwable root = rootCause(e);
            assertThat(root.getMessage()).contains("SMOA_LIBRARY_ID");
        });
    }

    @Test
    void local_프로파일은_자료실ID_형식이_잘못되면_실패한다() {
        assertThatThrownBy(() -> run("--spring.profiles.active=local", "--smoa.storage.library-id=bad id;drop"))
                .satisfies(e -> assertThat(rootCause(e).getMessage()).contains("SMOA_LIBRARY_ID", "형식"));
    }

    @Test
    void local_프로파일은_자료실ID가_있으면_모든_빈과_Mapper_계약이_연결되고_DB_연결_단계에서만_실패한다() {
        // 해석되지 않는 예약 도메인(db.invalid)·짧은 풀 타임아웃: 실제 DB 에는 연결하지 않는다. 빈 연결·Mapper 계약 검사가 먼저 통과해야
        // 이 지점(첫 DB 사용)까지 온다. 실패 원인이 "빈 없음/Mapper 누락/자료실 미지정"이 아님을 확인한다.
        assertThatThrownBy(() -> run("--spring.profiles.active=local", "--smoa.storage.library-id=LIB-TEST",
                "--spring.datasource.hikari.connection-timeout=250", "--spring.datasource.hikari.initialization-fail-timeout=-1"))
                .satisfies(e -> {
                    String chain = chainMessages(e);
                    assertThat(chain).doesNotContain("Mapper 계약이 완성되지 않아").doesNotContain("SMOA_LIBRARY_ID")
                            .doesNotContain("NoSuchBeanDefinition").doesNotContain("UnsatisfiedDependency")
                            .as(chain).containsAnyOf("SQLException", "UnknownHost", "Connection", "connect", "Communications");
                });
    }

    private static String chainMessages(Throwable t) {
        StringBuilder sb = new StringBuilder();
        for (Throwable c = t; c != null; c = c.getCause()) {
            sb.append(c.getClass().getSimpleName()).append(':').append(c.getMessage()).append('\n');
            if (c.getCause() == c) {
                break;
            }
        }
        return sb.toString();
    }

    @Test
    void local_memory_프로파일은_DataSource_없이_기동하고_메모리_저장소를_쓴다() {
        try (ConfigurableApplicationContext context = run("--spring.profiles.active=local-memory")) {
            assertThat(context.getBeanNamesForType(javax.sql.DataSource.class)).isEmpty();
            assertThat(context.getBeanNamesForType(com.smoa.account.memory.MemoryAccountRepository.class)).hasSize(1);
            assertThat(context.getBeanNamesForType(com.smoa.account.persistence.MyBatisAccountRepository.class)).isEmpty();
        }
    }
}
