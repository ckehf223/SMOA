package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.smoa.permission.PermissionPackage;
import com.smoa.program.Program;
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

/** 프로그램 정보 관리: 시드 24+1 개, 불변 ID, UUID/대문자/하이픈 ID, 미등록 모듈·경로 거부, 등록 후 패키지 권한 부여. */
class ProgramAdminApiTest extends ApiTestBase {

    private static Map<String, Object> body(String id, String path) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("programId", id);
        body.put("name", "새 화면");
        body.put("group", "사용자 추가");
        body.put("pagePath", path);
        body.put("moduleId", "analytics");
        body.put("actions", List.of("read", "export"));
        body.put("sortOrder", 900);
        return body;
    }

    @Test
    void 기존_프로그램_ID가_유지되고_콜링시트와_관리_프로그램이_등록되어_있다() throws Exception {
        TestClient admin = loggedInAdmin();
        JsonNode list = admin.json(admin.get("/api/admin/programs").andExpect(status().isOk()));
        List<String> ids = new java.util.ArrayList<>();
        list.forEach(p -> ids.add(p.get("programId").asText()));
        assertThat(ids).contains("dashboard", "regionData", "memberData", "classData", "findingStats", "diagnostics",
                "stagePerformance", "socialingManage", "socialingStats", "callingManage", "callingStats", "people",
                "activities", "regionalActivity", "stages", "history", "reports", "daily", "goals", "settings",
                "organization", "codes", "users", "permissions", "programs", "callingSheet");
        // 모든 시드 프로그램은 등록된 모듈을 가리킨다
        list.forEach(p -> assertThat(p.get("moduleId").asText()).isNotBlank());
        admin.get("/api/admin/modules").andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(10));
    }

    @Test
    void 미사용_프로그램은_기본_비활성이며_메뉴와_직접_호출에서_차단된다() throws Exception {
        TestClient admin = loggedInAdmin();
        PermissionPackage pkg = createPackage("이전 권한 패키지",
                perms("reports", full(), "daily", full(), "history", ro(), "callingManage", full(), "settings", ro()),
                org("R1", "D1"));
        TestClient user = loggedIn(createAccount(pkg));
        for (String id : List.of("reports", "daily", "history", "settings")) {
            assertThat(programs.findById(id)).map(Program::active).contains(false);
            for (TestClient client : List.of(admin, user)) {
                client.get("/api/auth/me").andExpect(jsonPath("$.menus[?(@.programId=='" + id + "')]").isEmpty());
                client.get("/pages/" + id + ".html").andExpect(status().isForbidden());
                client.get("/api/programs/" + id + "/module").andExpect(status().isForbidden());
            }
        }
        assertThat(packages.findById(pkg.packageId()).orElseThrow().permissions()).isEqualTo(pkg.permissions());
        user.get("/api/programs/callingManage/export/template.xlsx").andExpect(status().isOk());
    }

    @Test
    void 메뉴_배치는_총관리자만_수정하며_프로그램_ID와_권한을_유지한다() throws Exception {
        TestClient admin = loggedInAdmin();
        String first = "Move-Menu-1";
        String second = "Move-Menu-2";
        admin.post("/api/admin/programs", body(first, "/pages/move-menu-1.html")).andExpect(status().isCreated());
        admin.post("/api/admin/programs", body(second, "/pages/move-menu-2.html")).andExpect(status().isCreated());
        var pkg = createPackage("메뉴 권한 유지", perms(first, ro()), org("R1", "D1"));
        TestClient user = loggedIn(createAccount(pkg));
        var placement = Map.of("programId", first, "group", "관리 / 기준정보", "sortOrder", 76);
        var layout = Map.of("placements", List.of(placement, Map.of("programId", second, "sortOrder", 77)));
        user.patch("/api/admin/menu-layout", layout).andExpect(status().isForbidden());
        admin.patch("/api/admin/menu-layout", Map.of("placements",
                List.of(placement, Map.of("programId", second, "group", "메뉴 / / 상세", "sortOrder", 77))))
                .andExpect(status().isBadRequest());
        assertThat(programs.findById(first)).map(Program::group).contains("사용자 추가");
        admin.patch("/api/admin/menu-layout", layout).andExpect(status().isOk());
        assertThat(programs.findById(second)).map(Program::group).contains("사용자 추가");
        assertThat(programs.findById(second)).map(Program::sortOrder).contains(77);
        assertThat(packages.findById(pkg.packageId()).orElseThrow().permissions()).isEqualTo(pkg.permissions());
        user.get("/api/auth/me").andExpect(jsonPath("$.menus[0].programId").value(first))
                .andExpect(jsonPath("$.menus[0].group").value("관리 / 기준정보"));
    }

    @Test
    void 사용자_추가_ID는_UUID_대문자_하이픈을_허용하고_등록_후_패키지에_부여할_수_있다() throws Exception {
        TestClient admin = loggedInAdmin();
        String uuid = UUID.randomUUID().toString();
        admin.post("/api/admin/programs", body(uuid, "/pages/custom-" + uuid.substring(0, 8) + ".html"))
                .andExpect(status().isCreated()).andExpect(jsonPath("$.programId").value(uuid))
                .andExpect(jsonPath("$.moduleConnected").value(false));
        admin.post("/api/admin/programs", body("Custom-ABC_1", "/pages/custom-abc.html")).andExpect(status().isCreated());

        PermissionPackage pkg = createPackage("새화면", Map.of(), org("R1", "D1"));
        admin.patch("/api/admin/packages/" + pkg.packageId(),
                Map.of("permissions", Map.of(uuid, Map.of("access", true, "read", true, "write", false, "export", true))))
                .andExpect(status().isOk());
        TestClient user = loggedIn(createAccount(pkg));
        user.get("/api/auth/me").andExpect(jsonPath("$.menus[0].programId").value(uuid))
                .andExpect(jsonPath("$.menus[0].module").value("analytics"));
        user.get("/api/programs/" + uuid + "/module").andExpect(status().isOk()).andExpect(jsonPath("$.connected").value(false));
    }

    @Test
    void 이름_그룹_순서_경로를_바꿔도_programId는_그대로이고_바꾸려_하면_400() throws Exception {
        TestClient admin = loggedInAdmin();
        admin.post("/api/admin/programs", body("Rename-Me", "/pages/rename-me.html")).andExpect(status().isCreated());
        admin.patch("/api/admin/programs/Rename-Me", Map.of("name", "바뀐 이름", "group", "다른 그룹", "sortOrder", 5,
                "pagePath", "/pages/renamed.html")).andExpect(status().isOk())
                .andExpect(jsonPath("$.programId").value("Rename-Me")).andExpect(jsonPath("$.name").value("바뀐 이름"))
                .andExpect(jsonPath("$.sortOrder").value(5));
        assertThat(programs.findById("Rename-Me")).map(Program::pagePath).contains("/pages/renamed.html");
        admin.patch("/api/admin/programs/Rename-Me", Map.of("programId", "Other")).andExpect(status().isBadRequest());
        admin.patch("/api/admin/programs/NoSuchProgram", Map.of("name", "x")).andExpect(status().isNotFound());
    }

    @Test
    void 미등록_모듈_잘못된_경로_ID_중복_접근동작은_거부된다() throws Exception {
        TestClient admin = loggedInAdmin();
        Map<String, Object> unknownModule = body("Bad-Module", "/pages/bad-module.html");
        unknownModule.put("moduleId", "no-such-module");
        admin.post("/api/admin/programs", unknownModule).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("UNKNOWN_MODULE"));
        admin.post("/api/admin/programs", body("Bad-Path", "/pages/../secret.html")).andExpect(status().isBadRequest());
        admin.post("/api/admin/programs", body("Bad-Path2", "http://evil.example/x.html")).andExpect(status().isBadRequest());
        admin.post("/api/admin/programs", body("-badid", "/pages/x1.html")).andExpect(status().isBadRequest());
        admin.post("/api/admin/programs", body("has space", "/pages/x2.html")).andExpect(status().isBadRequest());
        admin.post("/api/admin/programs", body("people", "/pages/people-copy.html")).andExpect(status().isConflict());
        admin.post("/api/admin/programs", body("Dup-Path", "/pages/people.html")).andExpect(status().isConflict());
        Map<String, Object> accessAction = body("Access-Act", "/pages/access-act.html");
        accessAction.put("actions", List.of("access"));
        admin.post("/api/admin/programs", accessAction).andExpect(status().isBadRequest());
        Map<String, Object> unknownAction = body("Unknown-Act", "/pages/unknown-act.html");
        unknownAction.put("actions", List.of("delete"));
        admin.post("/api/admin/programs", unknownAction).andExpect(status().isBadRequest());
    }

    @Test
    void 총관리자_전용_관리_프로그램은_비활성화할_수_없고_일반_계정은_접근할_수_없다() throws Exception {
        TestClient admin = loggedInAdmin();
        admin.patch("/api/admin/programs/users", Map.of("active", false)).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("PROTECTED_PROGRAM"));
        admin.patch("/api/admin/programs/permissions", Map.of("active", false)).andExpect(status().isConflict());
        admin.patch("/api/admin/programs/programs", Map.of("active", false)).andExpect(status().isConflict());
        TestClient user = loggedIn(createAccount(createPackage("일반", perms("people", full()), org("R1", "D1"))));
        user.patch("/api/admin/programs/people", Map.of("active", false)).andExpect(status().isForbidden());
        user.get("/pages/programs.html").andExpect(status().isForbidden());
    }
}
