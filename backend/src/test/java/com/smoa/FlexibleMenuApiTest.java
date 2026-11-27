package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

@TestPropertySource(properties = "smoa.test.flexible-menu=true")
class FlexibleMenuApiTest extends ApiTestBase {
    private static final String PATH = "/api/admin/menu-layout";

    @Test
    void 상위_단독_화면과_한두_단계_폴더를_혼합해_저장하고_빈_폴더를_보존한다() throws Exception {
        var admin = loggedInAdmin();
        var reader = loggedIn(createAccount(createPackage("메뉴 검증", perms("regionData", ro()), org("R1", "D1"))));
        reader.get(PATH).andExpect(status().isForbidden());

        var initial = (ObjectNode) admin.json(admin.get(PATH).andExpect(status().isOk()));
        var placements = (ArrayNode) initial.path("placements");
        var groups = (ArrayNode) initial.path("groups");
        assertThat(placements.get(0).path("programId").asText()).isEqualTo("dashboard");
        assertThat(placement(placements, "dashboard").path("group").asText()).isEmpty();
        assertThat(placement(placements, "regionData").path("group").asText()).isEqualTo("데이터현황");
        assertThat(placement(placements, "callingStats").path("group").asText()).isEqualTo("데이터현황");
        assertThat(groups).allSatisfy(group -> assertThat(group.path("path").asText()).doesNotContain("/"));

        folder(groups, "상위", 12);
        folder(groups, "상위 / 집계", 13);
        folder(groups, "빈 폴더", 11);
        var moved = placement(placements, "regionData");
        moved.put("group", "상위 / 집계").put("sortOrder", 14).put("name", "새 구역별 데이터");
        var oldGrants = packages.findAll().stream()
                .filter(pkg -> pkg.name().startsWith("메뉴 검증")).findFirst().orElseThrow().permissions();
        reader.patch(PATH, initial).andExpect(status().isForbidden());
        admin.patch(PATH, initial).andExpect(status().isOk());

        var saved = admin.json(admin.get(PATH).andExpect(status().isOk()));
        assertThat(saved.path("groups")).anySatisfy(group -> {
            assertThat(group.path("path").asText()).isEqualTo("빈 폴더");
            assertThat(group.path("sortOrder").asInt()).isEqualTo(11);
        });
        assertThat(placement(saved.path("placements"), "regionData").path("group").asText()).isEqualTo("상위 / 집계");
        assertThat(placement(saved.path("placements"), "regionData").path("sortOrder").asInt()).isEqualTo(14);
        reader.get("/api/auth/me").andExpect(status().isOk())
                .andExpect(jsonPath("$.menus.length()").value(1))
                .andExpect(jsonPath("$.menus[0].programId").value("regionData"))
                .andExpect(jsonPath("$.menus[0].name").value("새 구역별 데이터"))
                .andExpect(jsonPath("$.menus[0].group").value("상위 / 집계"))
                .andExpect(jsonPath("$.menuGroups.length()").value(2))
                .andExpect(jsonPath("$.menuGroups[0].path").value("상위"))
                .andExpect(jsonPath("$.menuGroups[1].path").value("상위 / 집계"));
        assertThat(packages.findAll().stream()
                .filter(pkg -> pkg.name().startsWith("메뉴 검증")).findFirst().orElseThrow().permissions()).isEqualTo(oldGrants);

        moved.put("group", "");
        admin.patch(PATH, initial).andExpect(status().isOk());
        reader.get("/api/auth/me").andExpect(jsonPath("$.menus[0].group").value(""))
                .andExpect(jsonPath("$.menuGroups.length()").value(0));

        folder(groups, "상위 / 없는 부모 / 잘못된 폴더", 15);
        admin.patch(PATH, initial).andExpect(status().isBadRequest());
        assertThat(placement(admin.json(admin.get(PATH)).path("placements"), "regionData").path("group").asText()).isEmpty();
    }

    private static ObjectNode placement(JsonNode placements, String programId) {
        for (var placement : placements) {
            if (programId.equals(placement.path("programId").asText())) return (ObjectNode) placement;
        }
        throw new AssertionError("Missing placement " + programId);
    }

    private static void folder(ArrayNode groups, String path, int order) {
        groups.add(TestClient.mapper().createObjectNode().put("path", path).put("sortOrder", order));
    }
}
