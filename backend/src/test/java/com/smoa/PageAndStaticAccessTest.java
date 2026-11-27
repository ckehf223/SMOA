package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

import com.smoa.permission.PermissionPackage;
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

/** 공개 정적 자원 / 보호 페이지 / 알 수 없는 경로를 구분하고, 직접 page/api 우회를 차단한다. */
class PageAndStaticAccessTest extends ApiTestBase {

    @Test
    void 로그인과_셸_정적_자원은_로그인_없이_받을_수_있다() throws Exception {
        TestClient anon = client();
        anon.get("/login.html").andExpect(status().isOk()).andExpect(content().string(org.hamcrest.Matchers.containsString("login-form")));
        anon.get("/index.html").andExpect(status().isOk());
        anon.get("/").andExpect(status().isOk());
        anon.get("/assets/js/api.js").andExpect(status().isOk());
        anon.get("/assets/js/shell.js").andExpect(status().isOk());
        anon.get("/assets/css/app.css").andExpect(status().isOk());
        anon.get("/assets/modules/identity.js").andExpect(status().isOk());
        // CSP 는 외부 파일 스크립트만 허용한다
        anon.get("/login.html").andExpect(header().string("Content-Security-Policy", org.hamcrest.Matchers.containsString("default-src 'self'")));
    }

    @Test
    void 사용자_자료와_페이지는_공개되지_않고_알_수_없는_경로는_거부된다() throws Exception {
        TestClient anon = client();
        anon.get("/pages/people.html").andExpect(status().isUnauthorized());
        anon.get("/api/programs/people/items").andExpect(status().isUnauthorized());
        anon.get("/api/admin/accounts").andExpect(status().isUnauthorized());
        anon.get("/not-registered.html").andExpect(status().isUnauthorized());
        anon.get("/application.yml").andExpect(status().isUnauthorized());
        anon.get("/assets/../application.yml").andExpect(status().is4xxClientError());

        TestClient user = loggedIn(createAccount(createPackage("p", perms("people", full()), org("R1", "D1"))));
        user.get("/not-registered.html").andExpect(status().isForbidden());
        user.get("/mapper/account/AccountMapper.xml").andExpect(status().isForbidden());
        user.get("/pages/not-registered.html").andExpect(status().isForbidden());
        user.get("/pages/../application.yml").andExpect(status().is4xxClientError());
    }

    @Test
    void 페이지는_허용된_프로그램만_열린다() throws Exception {
        enableProgramDuringTest("history");
        PermissionPackage pkg = createPackage("페이지", perms("people", ro(), "history", ro()), org("R1", "D1"));
        TestClient user = loggedIn(createAccount(pkg));
        user.get("/pages/people.html").andExpect(status().isOk())
                .andExpect(content().string(org.hamcrest.Matchers.containsString("data-program-id=\"people\"")));
        user.get("/pages/history.html").andExpect(status().isOk());
        user.get("/pages/dashboard.html").andExpect(status().isForbidden());
        user.get("/pages/users.html").andExpect(status().isForbidden());
        user.get("/pages/programs.html").andExpect(status().isForbidden());
    }

    @Test
    void API_직접_호출은_프로그램_동작별로_차단된다() throws Exception {
        PermissionPackage pkg = createPackage("동작", perms("people", ro(), "activities", rw()), org("R1", "D1"));
        TestClient user = loggedIn(createAccount(pkg));
        user.get("/api/programs/people/items").andExpect(status().isOk());
        user.post("/api/programs/people/items", Map.of("name", "가상", "regionCode", "R1", "districtCode", "D1", "stageId", "찾B"))
                .andExpect(status().isForbidden());                                 // write 없음
        user.get("/api/programs/people/export/items.xlsx").andExpect(status().isForbidden()); // export 없음
        user.get("/api/programs/dashboard/module").andExpect(status().isForbidden());
        user.get("/api/programs/people/../history/items").andExpect(status().is4xxClientError());
        user.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options("/api/programs/people/items"))
                .andExpect(status().isForbidden());
        user.get("/api/admin/packages").andExpect(status().isForbidden());
    }

    @Test
    void 프론트_정적_자원이_클래스패스_static에_포장되어_있고_모든_모듈_스크립트와_페이지가_있다() throws Exception {
        for (String path : new String[] {"static/index.html", "static/login.html", "static/assets/css/app.css",
                "static/assets/js/api.js", "static/assets/js/shell.js", "static/assets/js/modules.js",
                "static/assets/js/login.js", "static/assets/js/ui.js"}) {
            assertThat(new ClassPathResource(path).exists()).as(path).isTrue();
        }
        for (String module : new String[] {"identity", "analytics", "records", "socialing", "calling", "imports", "goals",
                "organization"}) {
            assertThat(new ClassPathResource("static/assets/modules/" + module + ".js").exists()).as(module).isTrue();
        }
        String modulesJs = new String(new ClassPathResource("static/assets/js/modules.js").getInputStream().readAllBytes(),
                java.nio.charset.StandardCharsets.UTF_8);
        for (com.smoa.program.Program program : programs.findAll()) {
            assertThat(new ClassPathResource("static" + program.pagePath()).exists()).as(program.programId()).isTrue();
            assertThat(modulesJs).as("modules.js 에 모듈 등록: " + program.moduleId()).contains(program.moduleId() + ":");
        }
    }
}
