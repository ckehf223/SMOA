package com.smoa.calling;

import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

class CallingApiTest extends ApiTestBase {
    private static final String MANAGE = "/api/programs/callingManage";
    private static final String STATS = "/api/programs/callingStats";

    @Test
    void callingRoutesEnforcePermissionsCsrfAndDistrictsAndUseTheSameQueryForRowsAndReport() throws Exception {
        var admin = loggedInAdmin();
        String visibleTarget = person(admin, "R1", "가상R1");
        String hiddenTarget = person(admin, "R2", "가상R2");
        var first = admin.json(admin.post(MANAGE + "/items", calling(visibleTarget)).andExpect(status().isCreated()));
        var second = admin.json(admin.post(MANAGE + "/items", calling(hiddenTarget)).andExpect(status().isCreated()));
        String firstItem = MANAGE + "/items/" + first.path("id").asText();
        String secondItem = MANAGE + "/items/" + second.path("id").asText();
        try {
            var reader = loggedIn(createAccount(createPackage("콜링조회", perms("callingManage", ro(), "callingStats", ro()), org("R1", "D1"))));
            reader.get(MANAGE + "/page?includeSummary=true").andExpect(status().isOk())
                    .andExpect(jsonPath("$.items.length()").value(1))
                    .andExpect(jsonPath("$.items[0].personId").value(visibleTarget))
                    .andExpect(jsonPath("$.items[0].date").value("2026-01-04"))
                    .andExpect(jsonPath("$.summary.totals.count").value(1))
                    .andExpect(jsonPath("$.summary.connected.length()").value(1));
            reader.get(STATS + "/summary?round=1").andExpect(status().isOk())
                    .andExpect(jsonPath("$.totals.successes").value(1)).andExpect(jsonPath("$.connected.length()").value(0));
            reader.get(firstItem).andExpect(status().isOk()).andExpect(jsonPath("$.notes").value("***-****-0000"));
            reader.get(secondItem).andExpect(status().isNotFound());
            reader.get(MANAGE + "/targets").andExpect(status().isForbidden());
            reader.get(MANAGE + "/export/xlsx").andExpect(status().isForbidden());
            reader.post(MANAGE + "/items", calling(visibleTarget)).andExpect(status().isForbidden());
            admin.postWithoutCsrf(MANAGE + "/items", calling(visibleTarget)).andExpect(status().isForbidden());
            var mutation = new LinkedHashMap<>(calling(visibleTarget));
            mutation.put("rowVersion", first.path("rowVersion").asText());
            mutation.put("result", "부재");
            admin.put(firstItem, mutation).andExpect(status().isOk()).andExpect(jsonPath("$.result").value("부재"));
            admin.put(firstItem, mutation).andExpect(status().isConflict());
        } finally {
            for (String path : new String[] {firstItem, secondItem}) {
                String version = admin.json(admin.get(path).andExpect(status().isOk())).path("rowVersion").asText();
                admin.delete(path + "?rowVersion=" + version).andExpect(status().isNoContent());
            }
        }
    }

    private static String person(TestClient client, String region, String name) throws Exception {
        return client.json(client.post("/api/programs/people/items", Map.of("name", name,
                "regionCode", region, "districtCode", "D1", "stageId", "찾B", "foundDate", "2026-01-03"))
                .andExpect(status().isCreated())).path("id").asText();
    }

    private static Map<String, Object> calling(String personId) {
        return Map.of("personId", personId, "date", "2026-01-04", "time", "", "caller", "가상콜러", "round", "1차",
                "result", "만픽", "notes", "010-0000-0000");
    }
}
