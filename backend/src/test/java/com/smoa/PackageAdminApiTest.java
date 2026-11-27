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
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

/** 권한 패키지 CRUD API: 이름 자유, 프로그램·동작·구역 검증, 시스템 패키지 보호, 위조 필드 거부. */
class PackageAdminApiTest extends ApiTestBase {

    private static String unique(String prefix) {
        return prefix + UUID.randomUUID().toString().substring(0, 8);
    }

    private static Map<String, Object> perm(boolean access, boolean read, boolean write, boolean export) {
        return Map.of("access", access, "read", read, "write", write, "export", export);
    }

    private static Map<String, Object> scopeOrg(String... pairs) {
        List<Map<String, String>> districts = new java.util.ArrayList<>();
        for (int i = 0; i < pairs.length; i += 2) {
            districts.add(Map.of("regionCode", pairs[i], "districtCode", pairs[i + 1]));
        }
        return Map.of("type", "ORG", "districts", districts);
    }

    private Map<String, Object> body(String name) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("permissions", Map.of("people", perm(true, true, true, false), "history", perm(true, true, false, false)));
        body.put("dataScope", scopeOrg("R1", "D1", "R2", "D1"));
        return body;
    }

    @Test
    void 총관리자는_자유_이름의_패키지를_만들고_수정하고_삭제한다() throws Exception {
        TestClient admin = loggedInAdmin();
        String name = unique("콜링팀장-");
        JsonNode created = admin.json(admin.post("/api/admin/packages", body(name)).andExpect(status().isCreated())
                .andExpect(jsonPath("$.name").value(name)).andExpect(jsonPath("$.superAdmin").value(false))
                .andExpect(jsonPath("$.permissions.people.write").value(true))
                .andExpect(jsonPath("$.permissions.people.export").value(false))
                .andExpect(jsonPath("$.dataScope.districts.length()").value(2)));
        String id = created.get("packageId").asText();

        admin.patch("/api/admin/packages/" + id, Map.of("permissions", Map.of("people", perm(true, true, true, true)),
                "dataScope", Map.of("type", "ALL"))).andExpect(status().isOk())
                .andExpect(jsonPath("$.permissions.people.export").value(true))
                .andExpect(jsonPath("$.permissions.history").doesNotExist())
                .andExpect(jsonPath("$.dataScope.type").value("ALL"));
        PermissionPackage stored = packages.findById(id).orElseThrow();
        assertThat(stored.scope().type().name()).isEqualTo("ALL");
        admin.get("/api/admin/packages").andExpect(status().isOk());
        admin.delete("/api/admin/packages/" + id).andExpect(status().isNoContent());
        admin.get("/api/admin/packages/" + id).andExpect(status().isNotFound());
    }

    @Test
    void 일반_계정은_관리_API를_쓸_수_없다() throws Exception {
        TestClient user = loggedIn(createAccount(createPackage("일반", perms("people", full()), org("R1", "D1"))));
        user.get("/api/admin/packages").andExpect(status().isForbidden());
        user.get("/api/admin/programs").andExpect(status().isForbidden());
        user.get("/api/admin/accounts").andExpect(status().isForbidden());
        user.post("/api/admin/packages", body(unique("x"))).andExpect(status().isForbidden());
    }

    @Test
    void 이름이_총관리자여도_권한이_생기지_않고_superAdmin_입력은_거부된다() throws Exception {
        TestClient admin = loggedInAdmin();
        // 같은 이름은 시스템 패키지와 충돌(409)하므로 공백·대소문자만 다른 이름은 막힌다
        admin.post("/api/admin/packages", Map.of("name", " 총관리자 ")).andExpect(status().isConflict());
        Map<String, Object> forged = body(unique("위조-"));
        forged.put("superAdmin", true);
        admin.post("/api/admin/packages", forged).andExpect(status().isBadRequest());
        // 이름만 비슷한 일반 패키지는 /api/admin 에 접근할 수 없다
        PermissionPackage lookalike = createPackage("총관리자 ", perms("users", full()), org());
        TestClient fake = loggedIn(createAccount(lookalike));
        fake.get("/api/admin/accounts").andExpect(status().isForbidden());
        fake.get("/api/programs/users/ping").andExpect(status().isForbidden());
    }

    @Test
    void 시스템_패키지는_수정_비활성_삭제할_수_없다() throws Exception {
        TestClient admin = loggedInAdmin();
        String id = systemPackage().packageId();
        admin.patch("/api/admin/packages/" + id, Map.of("active", false)).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("SYSTEM_PACKAGE_PROTECTED"));
        admin.patch("/api/admin/packages/" + id, Map.of("name", "다른이름")).andExpect(status().isConflict());
        admin.delete("/api/admin/packages/" + id).andExpect(status().isConflict());
        assertThat(packages.findById(id).orElseThrow().active()).isTrue();
    }

    @Test
    void 등록되지_않은_프로그램_지원하지_않는_동작_상속_위반은_400() throws Exception {
        TestClient admin = loggedInAdmin();
        Map<String, Object> unknown = body(unique("a"));
        unknown.put("permissions", Map.of("noSuchProgram", perm(true, true, false, false)));
        admin.post("/api/admin/packages", unknown).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("UNKNOWN_PROGRAM"));

        Map<String, Object> unsupported = body(unique("b"));
        unsupported.put("permissions", Map.of("history", perm(true, true, true, false))); // history 에는 write 가 없다
        admin.post("/api/admin/packages", unsupported).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("ACTION_NOT_ALLOWED"));

        Map<String, Object> noRead = body(unique("c"));
        noRead.put("permissions", Map.of("people", perm(true, false, true, false)));
        admin.post("/api/admin/packages", noRead).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_PERMISSION"));

        Map<String, Object> noAccess = body(unique("d"));
        noAccess.put("permissions", Map.of("people", perm(false, true, false, false)));
        admin.post("/api/admin/packages", noAccess).andExpect(status().isBadRequest());

        Map<String, Object> adminOnly = body(unique("e"));
        adminOnly.put("permissions", Map.of("users", perm(true, true, true, false)));
        admin.post("/api/admin/packages", adminOnly).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("SUPER_ADMIN_ONLY"));
    }

    @Test
    void 잘못된_지역_구역은_400이고_같은_구역코드라도_지역이_다르면_별개다() throws Exception {
        TestClient admin = loggedInAdmin();
        Map<String, Object> badDistrict = body(unique("f"));
        badDistrict.put("dataScope", scopeOrg("R1", "D3")); // R1 에는 D3 가 없다(R2 에만 있다)
        admin.post("/api/admin/packages", badDistrict).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("UNKNOWN_DISTRICT"));
        Map<String, Object> inactive = body(unique("g"));
        inactive.put("dataScope", scopeOrg("R1", "D8")); // 비활성 구역
        admin.post("/api/admin/packages", inactive).andExpect(status().isBadRequest());
        Map<String, Object> inactiveRegion = body(unique("h"));
        inactiveRegion.put("dataScope", scopeOrg("R9", "D1")); // 비활성 지역
        admin.post("/api/admin/packages", inactiveRegion).andExpect(status().isBadRequest());
        Map<String, Object> allWithDistricts = body(unique("i"));
        allWithDistricts.put("dataScope", Map.of("type", "ALL", "districts", List.of(Map.of("regionCode", "R1", "districtCode", "D1"))));
        admin.post("/api/admin/packages", allWithDistricts).andExpect(status().isBadRequest());
        Map<String, Object> badCode = body(unique("j"));
        badCode.put("dataScope", scopeOrg("R1/", "D1"));
        admin.post("/api/admin/packages", badCode).andExpect(status().isBadRequest());

        // R1/D1 과 R2/D1 은 별개로 저장된다
        JsonNode created = admin.json(admin.post("/api/admin/packages", body(unique("k"))).andExpect(status().isCreated()));
        assertThat(created.get("dataScope").get("districts")).hasSize(2);
    }

    @Test
    void 이름_중복은_409이고_계정이_연결된_패키지는_삭제할_수_없다() throws Exception {
        TestClient admin = loggedInAdmin();
        String name = unique("중복-");
        admin.post("/api/admin/packages", body(name)).andExpect(status().isCreated());
        admin.post("/api/admin/packages", body(name.toUpperCase())).andExpect(status().isConflict());

        PermissionPackage used = createPackage("사용중", perms("people", ro()), org("R1", "D1"));
        createAccount(used);
        admin.delete("/api/admin/packages/" + used.packageId()).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("PACKAGE_IN_USE"));
    }

    @Test
    void 알_수_없는_필드와_잘못된_값은_400() throws Exception {
        TestClient admin = loggedInAdmin();
        Map<String, Object> unknownField = body(unique("l"));
        unknownField.put("role", "SUPER_ADMIN");
        admin.post("/api/admin/packages", unknownField).andExpect(status().isBadRequest());
        admin.post("/api/admin/packages", Map.of("name", "")).andExpect(status().isBadRequest());
    }
}
