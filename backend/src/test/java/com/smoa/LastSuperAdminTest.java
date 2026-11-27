package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import com.smoa.account.Account;
import com.smoa.permission.PermissionPackage;
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

/** 마지막 활성 총관리자 보호. 총관리자 수를 세므로 다른 테스트와 컨텍스트(메모리 저장소)를 공유하지 않는다. */
@SpringBootTest(properties = {"smoa.security.bcrypt-strength=4", "smoa.test.isolated=last-super-admin"})
@AutoConfigureMockMvc
@ActiveProfiles("local-memory")
class LastSuperAdminTest extends ApiTestBase {

    @Test
    void 마지막_활성_총관리자는_비활성화하거나_다른_패키지로_옮길_수_없다() throws Exception {
        Account only = createSuperAdmin();
        TestClient admin = loggedIn(only);
        assertThat(accounts.countActiveSuperAdmins()).isEqualTo(1);
        PermissionPackage normal = createPackage("일반", perms("people", ro()), org("R1", "D1"));

        admin.patch("/api/admin/accounts/" + only.id(), Map.of("active", false)).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("LAST_SUPER_ADMIN"));
        admin.patch("/api/admin/accounts/" + only.id(), Map.of("packageId", normal.packageId())).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("LAST_SUPER_ADMIN"));
        assertThat(accounts.findById(only.id()).orElseThrow().active()).isTrue();
        assertThat(accounts.findById(only.id()).orElseThrow().packageId()).isEqualTo(systemPackage().packageId());

        // 총관리자가 둘이 되면 하나는 정리할 수 있고, 남은 하나가 다시 마지막이 된다
        Account second = createSuperAdmin();
        admin.patch("/api/admin/accounts/" + second.id(), Map.of("active", false)).andExpect(status().isOk());
        admin.patch("/api/admin/accounts/" + only.id(), Map.of("active", false)).andExpect(status().isConflict());
        assertThat(accounts.countActiveSuperAdmins()).isEqualTo(1);
    }

    @Test
    void 총관리자_계정을_API로_새로_만들_수_있고_일반_패키지_계정은_총관리자_수에_포함되지_않는다() throws Exception {
        TestClient admin = loggedInAdmin();
        long before = accounts.countActiveSuperAdmins();
        PermissionPackage normal = createPackage("일반2", perms("people", ro()), org("R1", "D1"));
        createAccount(normal);
        assertThat(accounts.countActiveSuperAdmins()).isEqualTo(before);
        String name = "sa" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        admin.post("/api/admin/accounts", Map.of("username", name, "displayName", "보조 총관리자", "password", PASSWORD,
                "packageId", systemPackage().packageId())).andExpect(status().isCreated());
        assertThat(accounts.countActiveSuperAdmins()).isEqualTo(before + 1);
    }
}
