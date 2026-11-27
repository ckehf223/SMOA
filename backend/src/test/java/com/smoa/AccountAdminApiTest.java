package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.smoa.account.Account;
import com.smoa.permission.PermissionPackage;
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

/** 계정은 필수 패키지 하나. 직접 권한·범위·직책 입력은 400. 미존재/비활성 패키지 할당 차단. 여러 계정이 같은 패키지를 공유한다. */
class AccountAdminApiTest extends ApiTestBase {

    private static String uniqueName() {
        return "made" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
    }

    private Map<String, Object> body(String username, String packageId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("username", username);
        body.put("displayName", "가상 구역장");
        body.put("password", PASSWORD);
        body.put("packageId", packageId);
        return body;
    }

    @Test
    void 총관리자는_패키지를_골라_계정을_만들고_그_계정으로_로그인한다() throws Exception {
        TestClient admin = loggedInAdmin();
        PermissionPackage pkg = createPackage("1구역장", perms("people", rw()), org("R1", "D1"));
        String username = uniqueName();

        String response = admin.post("/api/admin/accounts", body(username, pkg.packageId())).andExpect(status().isCreated())
                .andExpect(jsonPath("$.packageId").value(pkg.packageId())).andExpect(jsonPath("$.packageName").value(pkg.name()))
                .andExpect(jsonPath("$.active").value(true)).andReturn().getResponse().getContentAsString();
        assertThat(response).doesNotContain(PASSWORD, "$2a$", "passwordHash", "password");

        TestClient user = client().loginOk(username, PASSWORD);
        user.get("/api/programs/people/options").andExpect(status().isOk());
        user.get("/api/programs/dashboard/module").andExpect(status().isForbidden());

        Account stored = accounts.findByUsernameKey(username).orElseThrow();
        assertThat(stored.passwordHash()).startsWith("$2").isNotEqualTo(PASSWORD);
    }

    @Test
    void 패키지_없이_또는_존재하지_않거나_비활성인_패키지로는_만들_수_없다() throws Exception {
        TestClient admin = loggedInAdmin();
        Map<String, Object> missing = body(uniqueName(), null);
        missing.remove("packageId");
        admin.post("/api/admin/accounts", missing).andExpect(status().isBadRequest());
        admin.post("/api/admin/accounts", body(uniqueName(), UUID.randomUUID().toString())).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("PACKAGE_NOT_FOUND"));
        PermissionPackage inactive = createPackage("비활성", Map.of(), org());
        packages.update(inactive.withActive(false));
        admin.post("/api/admin/accounts", body(uniqueName(), inactive.packageId())).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("PACKAGE_INACTIVE"));
    }

    @Test
    void 직접_권한_범위_직책_입력은_모두_400이고_저장되지_않는다() throws Exception {
        TestClient admin = loggedInAdmin();
        PermissionPackage pkg = createPackage("p", Map.of(), org());
        for (String forged : new String[] {"role", "permissions", "dataScope", "scope", "superAdmin"}) {
            String username = uniqueName();
            Map<String, Object> body = body(username, pkg.packageId());
            body.put(forged, forged.equals("role") ? "SUPER_ADMIN" : Map.of("everything", true));
            admin.post("/api/admin/accounts", body).andExpect(status().isBadRequest());
            assertThat(accounts.findByUsernameKey(username)).isEmpty();
        }
        Account target = createAccount(pkg);
        admin.patch("/api/admin/accounts/" + target.id(), Map.of("role", "SUPER_ADMIN")).andExpect(status().isBadRequest());
        admin.patch("/api/admin/accounts/" + target.id(), Map.of("permissions", Map.of())).andExpect(status().isBadRequest());
        assertThat(accounts.findById(target.id()).orElseThrow().packageId()).isEqualTo(pkg.packageId());
    }

    @Test
    void 여러_계정이_같은_패키지를_공유하고_패키지를_교체할_수_있다() throws Exception {
        TestClient admin = loggedInAdmin();
        PermissionPackage a = createPackage("A", perms("people", ro()), org("R1", "D1"));
        PermissionPackage b = createPackage("B", perms("history", ro()), org("R1", "D2"));
        Account first = createAccount(a);
        Account second = createAccount(a);
        assertThat(accounts.countByPackageId(a.packageId())).isEqualTo(2);

        admin.patch("/api/admin/accounts/" + second.id(), Map.of("packageId", b.packageId())).andExpect(status().isOk())
                .andExpect(jsonPath("$.packageId").value(b.packageId()));
        assertThat(accounts.findById(first.id()).orElseThrow().packageId()).isEqualTo(a.packageId());
        admin.patch("/api/admin/accounts/" + second.id(), Map.of("packageId", UUID.randomUUID().toString()))
                .andExpect(status().isBadRequest());
    }

    @Test
    void 중복_로그인ID는_대소문자와_무관하게_409() throws Exception {
        TestClient admin = loggedInAdmin();
        PermissionPackage pkg = createPackage("p", Map.of(), org());
        String username = uniqueName();
        admin.post("/api/admin/accounts", body(username, pkg.packageId())).andExpect(status().isCreated());
        admin.post("/api/admin/accounts", body(username.toUpperCase(), pkg.packageId())).andExpect(status().isConflict());
    }

    @Test
    void 약한_비밀번호와_잘못된_로그인ID는_400() throws Exception {
        TestClient admin = loggedInAdmin();
        PermissionPackage pkg = createPackage("p", Map.of(), org());
        Map<String, Object> weak = body(uniqueName(), pkg.packageId());
        weak.put("password", "short");
        admin.post("/api/admin/accounts", weak).andExpect(status().isBadRequest());
        admin.post("/api/admin/accounts", body("a b", pkg.packageId())).andExpect(status().isBadRequest());
    }

    @Test
    void 비밀번호_초기화는_로그인_세션을_끊고_새_비밀번호만_통한다() throws Exception {
        TestClient admin = loggedInAdmin();
        Account target = createAccount(createPackage("p", perms("people", ro()), org("R1", "D1")));
        TestClient session = loggedIn(target);
        session.get("/api/auth/me").andExpect(status().isOk());
        String newPassword = "Nn2-" + UUID.randomUUID();
        admin.put("/api/admin/accounts/" + target.id() + "/password", Map.of("newPassword", newPassword))
                .andExpect(status().isNoContent());
        session.get("/api/auth/me").andExpect(status().isUnauthorized());
        client().login(target.username(), PASSWORD).andExpect(status().isUnauthorized());
        client().login(target.username(), newPassword).andExpect(status().isOk());
    }

    @Test
    void 계정을_비활성화하면_기존_세션이_즉시_끊긴다() throws Exception {
        TestClient admin = loggedInAdmin();
        Account target = createAccount(createPackage("p", perms("people", ro()), org("R1", "D1")));
        TestClient session = loggedIn(target);
        admin.patch("/api/admin/accounts/" + target.id(), Map.of("active", false)).andExpect(status().isOk());
        session.get("/api/auth/me").andExpect(status().isUnauthorized());
        // 재활성화해도 이전 세션은 되살아나지 않는다
        admin.patch("/api/admin/accounts/" + target.id(), Map.of("active", true)).andExpect(status().isOk());
        session.get("/api/auth/me").andExpect(status().isUnauthorized());
    }
}
