package com.smoa.bootstrap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Optional;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Profile;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

import com.smoa.account.Account;
import com.smoa.account.AccountRepository;
import com.smoa.account.UnitOfWork;
import com.smoa.config.SmoaProperties;
import com.smoa.permission.DataScope;
import com.smoa.permission.PackageRepository;
import com.smoa.permission.PermissionPackage;
import com.smoa.program.Program;
import com.smoa.program.ProgramAction;
import com.smoa.program.ProgramCategory;
import com.smoa.program.ProgramRepository;

/** DB 연결 없이 Mockito 저장소로 DB 부트스트랩의 안전 규칙을 확인한다(가상 계정 값만 사용). */
class DbBootstrapTest {

    private static final String USER = "bootadmin";
    private static final String PASSWORD = "Aa1-" + java.util.UUID.randomUUID();

    private final AccountRepository accounts = mock(AccountRepository.class);
    private final PackageRepository packages = mock(PackageRepository.class);
    private final ProgramRepository programs = mock(ProgramRepository.class);
    private final PasswordEncoder encoder = new BCryptPasswordEncoder(4);
    private final UnitOfWork direct = new UnitOfWork() {
        @Override
        public <T> T execute(java.util.function.Supplier<T> work) {
            return work.get();
        }
    };

    private DbBootstrap bootstrap(boolean enabled, String environment, String profile, String user, String password) {
        SmoaProperties properties = new SmoaProperties(
                List.of(new SmoaProperties.SeedProgram("people", "대상자", "기록", ProgramCategory.BUSINESS,
                        List.of(ProgramAction.READ, ProgramAction.WRITE), "/pages/people.html", "records", false, false, 10),
                        new SmoaProperties.SeedProgram("users", "사용자", "관리", ProgramCategory.ADMIN,
                                List.of(ProgramAction.READ), "/pages/users.html", "identity", true, true, 20)),
                null, new SmoaProperties.Bootstrap(enabled, environment, user, password), null, null);
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles(profile);
        return new DbBootstrap(accounts, packages, programs, encoder, direct, properties, env);
    }

    @Test
    void 기본은_비활성이다() {
        ConditionalOnProperty condition = DbBootstrap.class.getAnnotation(ConditionalOnProperty.class);
        assertThat(condition.prefix()).isEqualTo("smoa.bootstrap");
        assertThat(condition.name()).containsExactly("enabled");
        assertThat(condition.havingValue()).isEqualTo("true");
        assertThat(condition.matchIfMissing()).isFalse();
        assertThat(DbBootstrap.class.getAnnotation(Profile.class).value()).containsExactlyInAnyOrder("local", "prod");
        assertThat(new SmoaProperties.Bootstrap(false, "", "", "").enabled()).isFalse();
        assertThat(new SmoaProperties.Bootstrap(true, "local", "u", "secret-value").toString()).doesNotContain("secret-value");
    }

    @Test
    void 환경_이름이_활성_프로파일과_다르면_아무것도_쓰지_않고_실패한다() {
        assertThatThrownBy(() -> bootstrap(true, "prod", "local", USER, PASSWORD).run(null))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("SMOA_BOOTSTRAP_ENVIRONMENT");
        assertThatThrownBy(() -> bootstrap(true, "", "local", USER, PASSWORD).run(null)).isInstanceOf(IllegalStateException.class);
        verify(accounts, never()).insert(any());
        verify(packages, never()).insert(any());
    }

    @Test
    void 자격_값이_없거나_정책에_맞지_않으면_실패하고_비밀번호를_메시지에_넣지_않는다() {
        assertThatThrownBy(() -> bootstrap(true, "local", "local", "", "").run(null)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> bootstrap(true, "local", "local", USER, "weak").run(null))
                .isInstanceOf(IllegalStateException.class).satisfies(e -> assertThat(e.getMessage()).doesNotContain("weak"));
        verify(accounts, never()).insert(any());
    }

    @Test
    void 계정이_하나라도_있으면_덮어쓰지_않고_아무것도_쓰지_않는다() {
        when(accounts.count()).thenReturn(1L);
        assertThatCode(() -> bootstrap(true, "local", "local", USER, PASSWORD).run(null)).doesNotThrowAnyException();
        verify(accounts, never()).insert(any());
        verify(accounts, never()).update(any());
        verify(packages, never()).insert(any());
        verify(packages, never()).update(any());
        verify(programs, never()).insert(any());
        verify(programs, never()).update(any());
    }

    @Test
    void 비어_있으면_SYSTEM_패키지_프로그램_계정을_만들고_해시만_저장한다() {
        when(accounts.count()).thenReturn(0L);
        when(packages.findById("SYSTEM")).thenReturn(Optional.empty());
        when(programs.findById(any())).thenReturn(Optional.empty());
        when(programs.findByPagePath(any())).thenReturn(Optional.empty());
        bootstrap(true, "prod", "prod", USER, PASSWORD).run(null);

        ArgumentCaptor<PermissionPackage> pkg = ArgumentCaptor.forClass(PermissionPackage.class);
        verify(packages).insert(pkg.capture());
        assertThat(pkg.getValue().packageId()).isEqualTo("SYSTEM");
        assertThat(pkg.getValue().superAdmin()).isTrue();
        assertThat(pkg.getValue().active()).isTrue();
        assertThat(pkg.getValue().scope()).isEqualTo(DataScope.all());

        ArgumentCaptor<Program> program = ArgumentCaptor.forClass(Program.class);
        verify(programs, org.mockito.Mockito.times(2)).insert(program.capture());
        assertThat(program.getAllValues()).extracting(Program::programId).containsExactly("people", "users");
        assertThat(program.getAllValues()).extracting(Program::active).containsExactly(false, true);
        assertThat(program.getAllValues().get(1).superAdminOnly()).isTrue();

        ArgumentCaptor<Account> account = ArgumentCaptor.forClass(Account.class);
        verify(accounts).insert(account.capture());
        assertThat(account.getValue().username()).isEqualTo(USER);
        assertThat(account.getValue().packageId()).isEqualTo("SYSTEM");
        assertThat(account.getValue().active()).isTrue();
        assertThat(account.getValue().passwordHash()).isNotEqualTo(PASSWORD).startsWith("$2");
        assertThat(encoder.matches(PASSWORD, account.getValue().passwordHash())).isTrue();
        assertThat(account.getValue().toString()).doesNotContain(PASSWORD).doesNotContain(account.getValue().passwordHash());
    }

    @Test
    void 이미_있는_프로그램과_같은_경로의_기존_메뉴는_건드리지_않는다() {
        when(accounts.count()).thenReturn(0L);
        when(packages.findById("SYSTEM")).thenReturn(Optional.empty());
        Program existing = new Program("people", "기존", "g", ProgramCategory.BUSINESS, "/pages/people.html", "records",
                java.util.Set.of(), false, true, 1);
        when(programs.findById("people")).thenReturn(Optional.of(existing));
        when(programs.findById("users")).thenReturn(Optional.empty());
        when(programs.findByPagePath("/pages/users.html")).thenReturn(Optional.of(existing));   // 다른 ID 가 같은 경로를 이미 사용
        bootstrap(true, "local", "local", USER, PASSWORD).run(null);
        verify(programs, never()).insert(any());
        verify(programs, never()).update(any());
    }

    @Test
    void SYSTEM_이_있는데_총관리자_패키지가_아니면_자동으로_바꾸지_않고_실패한다() {
        when(accounts.count()).thenReturn(0L);
        when(packages.findById("SYSTEM")).thenReturn(Optional.of(new PermissionPackage("SYSTEM", "다른", true, false, java.util.Map.of(),
                DataScope.none())));
        assertThatThrownBy(() -> bootstrap(true, "local", "local", USER, PASSWORD).run(null)).isInstanceOf(IllegalStateException.class);
        verify(packages, never()).update(any());
        verify(accounts, never()).insert(any());
    }
}
