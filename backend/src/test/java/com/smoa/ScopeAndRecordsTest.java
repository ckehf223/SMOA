package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.ByteArrayInputStream;
import java.util.LinkedHashMap;
import java.util.Map;

import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.smoa.permission.PermissionPackage;
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

/**
 * 구역 범위(지역+구역 복합키)와 records 모듈의 실제 업무 동작(local-memory 가상 자료):
 * 서로 다른 지역의 같은 구역 코드 차단, 0건/거부, 단계 이동·탈락·복귀 이력, 활동, 엑셀 내보내기 재독.
 */
class ScopeAndRecordsTest extends ApiTestBase {

    private static Map<String, Object> person(String name, String region, String district) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("regionCode", region);
        body.put("districtCode", district);
        body.put("stageId", "찾B");
        body.put("gender", "여");
        body.put("age", 30);
        return body;
    }

    private TestClient userWith(String name, Map<String, com.smoa.permission.ActionPermission> perms,
            com.smoa.permission.DataScope scope) throws Exception {
        return loggedIn(createAccount(createPackage(name, perms, scope)));
    }

    private String create(TestClient client, String name, String region, String district) throws Exception {
        return client.json(client.post("/api/programs/people/items", person(name, region, district))
                .andExpect(status().isCreated())).get("id").asText();
    }

    @Test
    void 서로_다른_지역의_같은_구역코드는_별개이고_범위_밖_자료는_보이지_않는다() throws Exception {
        TestClient all = userWith("전체", perms("people", full()), com.smoa.permission.DataScope.all());
        String r1d1 = create(all, "R1D1사람", "R1", "D1");
        String r2d1 = create(all, "R2D1사람", "R2", "D1");

        TestClient r1Leader = userWith("R1D1장", perms("people", rw()), org("R1", "D1"));
        r1Leader.get("/api/programs/people/items").andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].name").value("R1D1사람"));
        r1Leader.get("/api/programs/people/items/" + r1d1).andExpect(status().isOk());
        r1Leader.get("/api/programs/people/items/" + r2d1).andExpect(status().isNotFound());   // 존재 여부를 알리지 않는다
        // 클라이언트가 보낸 구역 파라미터로 범위를 넓힐 수 없다
        r1Leader.get("/api/programs/people/items?regionCode=R2&districtCode=D1").andExpect(jsonPath("$.length()").value(0));
        r1Leader.put("/api/programs/people/items/" + r2d1, Map.of("name", "탈취")).andExpect(status().isNotFound());
        r1Leader.delete("/api/programs/people/items/" + r2d1).andExpect(status().isNotFound());
        r1Leader.post("/api/programs/people/items/" + r2d1 + "/stage", Map.of("stageId", "콜링")).andExpect(status().isNotFound());
        r1Leader.post("/api/programs/people/items", person("범위밖", "R2", "D1")).andExpect(status().isForbidden());
        // 구역 이동(수정)으로 범위 밖으로 보낼 수 없다
        r1Leader.put("/api/programs/people/items/" + r1d1, Map.of("regionCode", "R2", "districtCode", "D1", "rowVersion", 1))
                .andExpect(status().isForbidden());
        all.get("/api/programs/people/items/" + r2d1).andExpect(jsonPath("$.name").value("R2D1사람"));
        all.get("/api/programs/people/items/" + r1d1).andExpect(jsonPath("$.regionCode").value("R1"));
    }

    @Test
    void 배정된_구역이_없으면_목록은_0건이고_단건_쓰기는_거부된다() throws Exception {
        TestClient all = userWith("전체2", perms("people", full()), com.smoa.permission.DataScope.all());
        String id = create(all, "누군가", "R1", "D2");
        TestClient none = userWith("무배정", perms("people", full()), org());
        none.get("/api/programs/people/items").andExpect(jsonPath("$.length()").value(0));
        none.get("/api/programs/people/items/" + id).andExpect(status().isNotFound());
        none.post("/api/programs/people/items", person("x", "R1", "D2")).andExpect(status().isForbidden());
        none.get("/api/programs/people/options").andExpect(jsonPath("$.districts.length()").value(0));
        none.get("/api/programs/history/items").andExpect(status().isForbidden()); // history 권한 자체가 없음
    }

    @Test
    void 비활성_구역은_범위가_ALL이어도_자료를_만들거나_볼_수_없다() throws Exception {
        TestClient all = userWith("전체3", perms("people", full()), com.smoa.permission.DataScope.all());
        all.post("/api/programs/people/items", person("비활성구역", "R1", "D8")).andExpect(status().isForbidden());
        all.post("/api/programs/people/items", person("비활성지역", "R9", "D1")).andExpect(status().isForbidden());
        all.post("/api/programs/people/items", person("없는구역", "R1", "D77")).andExpect(status().isForbidden());
        all.get("/api/programs/people/options").andExpect(status().isOk())
                .andExpect(jsonPath("$.districts[?(@.districtCode=='D8')]").isEmpty());
    }

    @Test
    void 단계_이동_탈락_복귀는_변경_이력에_남고_단계_이동_분석에_집계된다() throws Exception {
        enableProgramDuringTest("history");
        PermissionPackage pkg = createPackage("기록", perms("people", full(), "history", ro(), "stages", ro()), org("R1", "D1"));
        TestClient user = loggedIn(createAccount(pkg));
        String id = create(user, "이력대상", "R1", "D1");

        user.post("/api/programs/people/items/" + id + "/stage", Map.of("stageId", "콜링", "reason", "연결", "rowVersion", 1))
                .andExpect(status().isOk()).andExpect(jsonPath("$.stageId").value("콜링"));
        user.post("/api/programs/people/items/" + id + "/stage", Map.of("stageId", "콜링")).andExpect(status().isBadRequest());
        user.post("/api/programs/people/items/" + id + "/stage", Map.of("stageId", "없는단계")).andExpect(status().isBadRequest());
        user.post("/api/programs/people/items/" + id + "/dropout", Map.of("effectiveDate", "2026-01-05", "reason", "사정", "rowVersion", 2))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("dropped"));
        user.post("/api/programs/people/items/" + id + "/dropout", Map.of("effectiveDate", "2026-01-06", "rowVersion", 3)).andExpect(status().isConflict());
        user.post("/api/programs/people/items/" + id + "/return", Map.of("effectiveDate", "2026-02-01", "rowVersion", 3))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("active"));
        user.post("/api/programs/people/items/" + id + "/return", Map.of("effectiveDate", "2026-02-02", "rowVersion", 4)).andExpect(status().isConflict());

        JsonNode history = user.json(user.get("/api/programs/history/items?personId=" + id).andExpect(status().isOk()));
        // 최신 요구: 새 대상자는 단계 이력의 기준(최초) 행(STAGE_BASELINE)을 먼저 갖는다(원본 TGSTGLOG 의미). 그래서 4 → 5건.
        assertThat(history).hasSize(5);
        Map<String, JsonNode> byType = new java.util.HashMap<>();
        history.forEach(entry -> byType.put(entry.get("type").asText(), entry));
        assertThat(byType.keySet()).containsExactlyInAnyOrder("STAGE_BASELINE", "CREATED", "STAGE_CHANGED", "DROPPED", "RESTORED");
        assertThat(byType.get("STAGE_BASELINE").get("baseline").asBoolean()).isTrue();
        assertThat(byType.get("STAGE_CHANGED").get("fromValue").asText()).isEqualTo("찾B");
        assertThat(byType.get("STAGE_CHANGED").get("toValue").asText()).isEqualTo("콜링");

        user.get("/api/programs/stages/summary").andExpect(status().isOk()).andExpect(jsonPath("$.total").value(1))
                .andExpect(jsonPath("$.transitions['찾B → 콜링']").value(1));
        user.get("/api/programs/stages/summary?from=2999-01-01").andExpect(jsonPath("$.total").value(0));

        // 다른 구역 사용자는 이 이력을 볼 수 없다
        TestClient other = loggedIn(createAccount(createPackage("다른", perms("history", ro(), "stages", ro()), org("R2", "D1"))));
        other.get("/api/programs/history/items").andExpect(jsonPath("$.length()").value(0));
        other.get("/api/programs/stages/summary").andExpect(jsonPath("$.total").value(0));
    }

    @Test
    void 입력_검증_식별번호_미래_날짜_나이_알수없는_구역() throws Exception {
        TestClient user = userWith("검증", perms("people", full()), org("R1", "D1"));
        Map<String, Object> badCode = person("코드", "R1", "D1");
        badCode.put("code", "1234");
        user.post("/api/programs/people/items", badCode).andExpect(status().isBadRequest());
        Map<String, Object> goodCode = person("코드", "R1", "D1");
        goodCode.put("code", "ABC-100");
        user.post("/api/programs/people/items", goodCode).andExpect(status().isCreated());
        // 최신 요구 변경: 식별번호(TGT_CODE)·이름·연락처·LEGACY_ID 는 중복 허용이므로 같은 식별번호도 별개 대상자로 만들어진다(기존 409 기대를 폐기).
        user.post("/api/programs/people/items", goodCode).andExpect(status().isCreated());
        Map<String, Object> future = person("미래", "R1", "D1");
        future.put("registeredDate", "2999-01-01");
        user.post("/api/programs/people/items", future).andExpect(status().isBadRequest());
        Map<String, Object> badAge = person("나이", "R1", "D1");
        badAge.put("age", 200);
        user.post("/api/programs/people/items", badAge).andExpect(status().isBadRequest());
        Map<String, Object> noName = person(" ", "R1", "D1");
        user.post("/api/programs/people/items", noName).andExpect(status().isBadRequest());
        Map<String, Object> noRegion = person("지역없음", "R1", "D1");
        noRegion.remove("regionCode");
        user.post("/api/programs/people/items", noRegion).andExpect(status().isBadRequest());
        Map<String, Object> phone = person("연락처", "R1", "D1");
        phone.put("phone", "not-a-phone");
        user.post("/api/programs/people/items", phone).andExpect(status().isBadRequest()); // 연락처 형식 오류
        Map<String, Object> unknown = person("미지정", "R1", "D1");
        unknown.put("password", "x");
        user.post("/api/programs/people/items", unknown).andExpect(status().isBadRequest()); // 허용 목록에 없는 필드
    }

    @Test
    void 삭제는_복구할_수_있고_삭제된_대상자는_기본_목록에서_빠진다() throws Exception {
        TestClient user = userWith("삭제", perms("people", full(), "history", ro()), org("R1", "D1"));
        String id = create(user, "삭제대상", "R1", "D1");
        user.delete("/api/programs/people/items/" + id + "?rowVersion=1").andExpect(status().isNoContent());
        user.get("/api/programs/people/items").andExpect(jsonPath("$.length()").value(0));
        user.get("/api/programs/people/items?includeDeleted=true").andExpect(jsonPath("$[0].deleted").value(true));
        user.put("/api/programs/people/items/" + id, Map.of("name", "수정")).andExpect(status().isNotFound());
        user.post("/api/programs/people/items/" + id + "/undelete?rowVersion=2", Map.of()).andExpect(status().isOk());
        user.get("/api/programs/people/items").andExpect(jsonPath("$.length()").value(1));
    }

    @Test
    void 활동_기록은_대상자의_구역_범위를_따른다() throws Exception {
        TestClient all = userWith("전체4", perms("people", full(), "activities", full()), com.smoa.permission.DataScope.all());
        String r2 = create(all, "R2대상", "R2", "D1");
        TestClient r1 = userWith("활동R1", perms("people", rw(), "activities", rw()), org("R1", "D1"));
        String mine = create(r1, "R1대상", "R1", "D1");

        r1.post("/api/programs/activities/items", Map.of("personId", r2, "date", "2026-01-02", "type", "방문")).andExpect(status().isNotFound());
        String activityId = r1.json(r1.post("/api/programs/activities/items",
                Map.of("personId", mine, "date", "2026-01-02", "type", "방문", "memo", "첫 방문")).andExpect(status().isCreated())).get("id").asText();
        r1.get("/api/programs/activities/items").andExpect(jsonPath("$.length()").value(1));
        r1.put("/api/programs/activities/items/" + activityId, Map.of("memo", "수정됨", "rowVersion", 1)).andExpect(jsonPath("$.memo").value("수정됨"));
        r1.post("/api/programs/activities/items", Map.of("personId", mine, "date", "2999-01-01", "type", "방문")).andExpect(status().isBadRequest());
        all.get("/api/programs/activities/items").andExpect(jsonPath("$.length()").value(1));
        TestClient other = userWith("활동R2", perms("activities", rw()), org("R2", "D1"));
        other.get("/api/programs/activities/items").andExpect(jsonPath("$.length()").value(0));
        other.delete("/api/programs/activities/items/" + activityId).andExpect(status().isNotFound());
        r1.delete("/api/programs/activities/items/" + activityId + "?rowVersion=2").andExpect(status().isNoContent());
    }

    @Test
    void 엑셀_내보내기는_범위_안_자료만_담고_다시_읽을_수_있으며_수식과_연락처가_없다() throws Exception {
        TestClient all = userWith("전체5", perms("people", full()), com.smoa.permission.DataScope.all());
        create(all, "=HYPERLINK(\"x\")", "R2", "D3");
        TestClient r1 = userWith("엑셀R1", perms("people", full()), org("R1", "D2"));
        create(r1, "내보내기A", "R1", "D2");
        create(r1, "내보내기B", "R1", "D2");

        byte[] bytes = r1.get("/api/programs/people/export/items.xlsx").andExpect(status().isOk())
                .andReturn().getResponse().getContentAsByteArray();
        try (XSSFWorkbook workbook = new XSSFWorkbook(new ByteArrayInputStream(bytes))) {
            Sheet sheet = workbook.getSheetAt(0);
            assertThat(sheet.getRow(0).getCell(0).getStringCellValue()).isEqualTo("식별번호");
            assertThat(sheet.getRow(0).getLastCellNum()).isEqualTo((short) com.smoa.records.PeopleXlsx.HEADERS.size());
            assertThat(sheet.getLastRowNum()).isEqualTo(2);                       // 헤더 + R1/D2 두 명
            java.util.Set<String> names = new java.util.HashSet<>();
            for (int i = 1; i <= sheet.getLastRowNum(); i++) {
                names.add(sheet.getRow(i).getCell(1).getStringCellValue());
                assertThat(sheet.getRow(i).getCell(4).getStringCellValue()).isEqualTo("R1");
            }
            assertThat(names).containsExactlyInAnyOrder("내보내기A", "내보내기B");
            assertThat(com.smoa.records.PeopleXlsx.HEADERS).noneMatch(h -> h.contains("연락") || h.contains("전화"));
        }
        // 관리자 전체 내보내기에서 수식 시작 문자열은 무력화된다
        byte[] allBytes = all.get("/api/programs/people/export/items.xlsx").andReturn().getResponse().getContentAsByteArray();
        try (XSSFWorkbook workbook = new XSSFWorkbook(new ByteArrayInputStream(allBytes))) {
            Sheet sheet = workbook.getSheetAt(0);
            boolean found = false;
            for (int i = 1; i <= sheet.getLastRowNum(); i++) {
                String name = sheet.getRow(i).getCell(1).getStringCellValue();
                if (name.contains("HYPERLINK")) {
                    found = true;
                    assertThat(name).startsWith("'=");
                }
            }
            assertThat(found).isTrue();
        }
    }
}
