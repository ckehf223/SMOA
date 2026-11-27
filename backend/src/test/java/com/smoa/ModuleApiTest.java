package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;

import org.junit.jupiter.api.Test;

import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

/** 업무 모듈 경계: 연결된 프로그램과 미연결 프로그램의 상태, 미연결 데이터는 501(성공·빈 목록으로 가장하지 않음). */
class ModuleApiTest extends ApiTestBase {

    @Test
    void 연결된_모듈과_미연결_모듈의_상태를_허용된_프로그램에만_알려_준다() throws Exception {
        TestClient user = loggedIn(createAccount(createPackage("모듈", perms("people", ro(), "dashboard", ro(), "organization", ro()), org("R1", "D1"))));
        user.get("/api/programs/people/module").andExpect(status().isOk()).andExpect(jsonPath("$.connected").value(true))
                .andExpect(jsonPath("$.state").value("CONNECTED"));
        String notConnected = user.get("/api/programs/organization/module").andExpect(status().isOk())
                .andExpect(jsonPath("$.connected").value(false)).andExpect(jsonPath("$.state").value("NOT_CONNECTED"))
                .andExpect(jsonPath("$.message").value("데이터 연결 준비 중입니다."))
                .andReturn().getResponse().getContentAsString();
        // 구현 세부는 노출하지 않는다
        assertThat(notConnected).doesNotContain("com.smoa", "Mapper", "SELECT", "Exception");
        user.get("/api/programs/regionData/module").andExpect(status().isForbidden()); // 허용되지 않은 프로그램
    }

    @Test
    void 미연결_업무_데이터는_501이고_연결된_프로그램의_없는_경로는_404() throws Exception {
        TestClient user = loggedIn(createAccount(createPackage("모듈2", perms("dashboard", ro(), "organization", ro(), "people", ro()), org("R1", "D1"))));
        user.get("/api/programs/organization/data/summary").andExpect(status().isNotImplemented())
                .andExpect(jsonPath("$.code").value("MODULE_NOT_CONNECTED"));
        user.get("/api/programs/dashboard/data/summary").andExpect(status().isOk())
                .andExpect(jsonPath("$.totals.people").isNumber());
        user.get("/api/programs/people/data/anything").andExpect(status().isNotFound());
        // 권한이 없으면 501 이전에 403
        user.get("/api/programs/goals/data/list").andExpect(status().isForbidden());
        // 읽기 전용이면 쓰기 요청은 501 이 아니라 403
        user.post("/api/programs/dashboard/data/summary", Map.of()).andExpect(status().isForbidden());
    }

    @Test
    void 모듈_등록부는_프로그램_시드가_가리키는_모든_모듈을_가지고_있다() throws Exception {
        for (com.smoa.program.Program p : programs.findAll()) {
            assertThat(p.moduleId()).isNotBlank();
        }
        TestClient admin = loggedInAdmin();
        admin.get("/api/admin/modules").andExpect(jsonPath("$[?(@.moduleId=='records')].connectedProgramIds[0]").exists());
    }
}
