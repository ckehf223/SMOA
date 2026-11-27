package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;

import com.fasterxml.jackson.databind.JsonNode;
import com.smoa.account.Account;
import com.smoa.permission.PermissionPackage;
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

/** 로그인(csrf → formLogin → 새 csrf → me)·me 응답 형태·401/403·로그아웃. */
class AuthFlowTest extends ApiTestBase {

    @Test
    void 로그인_후_me는_단일_패키지와_허용된_프로그램만_보여_주고_비밀_값은_없다() throws Exception {
        enableProgramDuringTest("history");
        PermissionPackage pkg = createPackage("1구역장", perms("people", rw(), "history", ro()), org("R1", "D1"));
        Account account = createAccount(pkg);

        TestClient client = client();
        var login = client.login(account.username(), PASSWORD).andExpect(status().isOk());
        String body = login.andReturn().getResponse().getContentAsString();
        assertThat(body).doesNotContain(PASSWORD, "$2a$", "passwordHash", "password", "credentialVersion");
        client.refreshCsrf();

        JsonNode me = client.json(client.get("/api/auth/me").andExpect(status().isOk())
                .andExpect(jsonPath("$.pkg.name").value(pkg.name()))
                .andExpect(jsonPath("$.noMenu").value(false)).andExpect(jsonPath("$.admin").value(false))
                .andExpect(jsonPath("$.devMemory").value(true)));
        assertThat(me.get("menus")).hasSize(2);
        assertThat(me.get("menus").get(0).get("programId").asText()).isEqualTo("people"); // sortOrder 순(people < history)
        assertThat(me.get("permissions").has("dashboard")).isFalse();
        assertThat(me.get("permissions").get("people").get("write").asBoolean()).isTrue();
        assertThat(me.get("permissions").get("people").get("export").asBoolean()).isFalse();
        assertThat(me.get("dataScope").get("type").asText()).isEqualTo("ORG");
        assertThat(me.get("dataScope").get("districts").get(0).get("regionCode").asText()).isEqualTo("R1");
        assertThat(me.has("role")).isFalse();
    }

    @Test
    void 패키지가_없는_메뉴_계정은_noMenu이고_대시보드를_강제하지_않는다() throws Exception {
        Account account = createAccount(createPackage("빈패키지", Map.of(), org()));
        TestClient client = loggedIn(account);
        client.get("/api/auth/me").andExpect(status().isOk()).andExpect(jsonPath("$.noMenu").value(true))
                .andExpect(jsonPath("$.menus").isEmpty());
    }

    @Test
    void 로그인_실패는_계정_존재_여부와_무관하게_같은_응답이다() throws Exception {
        Account account = createAccount(createPackage("p", Map.of(), org()));
        String wrongPassword = client().login(account.username(), "Wrong-" + PASSWORD).andExpect(status().isUnauthorized())
                .andReturn().getResponse().getContentAsString();
        String unknownUser = client().login("ghost-" + account.username(), PASSWORD).andExpect(status().isUnauthorized())
                .andReturn().getResponse().getContentAsString();
        assertThat(wrongPassword).isEqualTo(unknownUser);
    }

    @Test
    void 미인증은_401_CSRF_없는_변경_요청은_403() throws Exception {
        client().get("/api/auth/me").andExpect(status().isUnauthorized());
        client().get("/api/programs/people/items").andExpect(status().isUnauthorized());
        client().get("/api/admin/programs").andExpect(status().isUnauthorized());
        TestClient admin = loggedInAdmin();
        admin.postWithoutCsrf("/api/admin/packages", Map.of("name", "x")).andExpect(status().isForbidden());
    }

    @Test
    void 로그아웃하면_세션이_끊긴다() throws Exception {
        TestClient client = loggedInAdmin();
        client.get("/api/auth/me").andExpect(status().isOk());
        client.logout().andExpect(status().isOk());
        client.get("/api/auth/me").andExpect(status().isUnauthorized());
    }

    @Test
    void 비활성_계정은_로그인할_수_없다() throws Exception {
        Account account = createAccount(createPackage("p", Map.of(), org()));
        accounts.update(account.withActive(false));
        client().login(account.username(), PASSWORD).andExpect(status().isUnauthorized());
    }

    @Test
    void 로그인은_폼_전송만_받고_JSON_본문은_인증하지_못한다() throws Exception {
        Account account = createAccount(createPackage("p", Map.of(), org()));
        TestClient client = client();
        client.refreshCsrf();
        client.perform(MockMvcRequestBuilders.post("/api/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content("{\"username\":\"" + account.username() + "\",\"password\":\"" + PASSWORD + "\"}")
                .header(TestClient.CSRF_HEADER, client.csrf())).andExpect(status().isUnauthorized());
    }
}
