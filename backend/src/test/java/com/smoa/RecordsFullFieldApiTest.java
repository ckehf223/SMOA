package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import com.fasterxml.jackson.databind.JsonNode;
import com.smoa.crypto.ContactVault;
import com.smoa.permission.DataScope;
import com.smoa.records.PeopleXlsx;
import com.smoa.records.Person;
import com.smoa.records.PersonField;
import com.smoa.records.RecordRepository;
import com.smoa.records.memory.MemoryRecordRepository;
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

/**
 * 전체 원본 필드·부분 수정·명시 null 규칙·ROW_VERSION 409·연락처(끝 네 자리/암호화)·독립 활동·단계 시각을 local-memory 가상 자료로 검증한다.
 */
class RecordsFullFieldApiTest extends ApiTestBase {

    @Autowired
    private ContactVault vault;
    @Autowired
    private MemoryRecordRepository memory;

    private TestClient admin() throws Exception {
        return loggedIn(createAccount(createPackage("전체필드", perms("people", full(), "activities", full(), "history", full(), "stages", full()),
                DataScope.all())));
    }

    private TestClient r1(String... programs) throws Exception {
        Map<String, com.smoa.permission.ActionPermission> p = new LinkedHashMap<>();
        for (String program : programs) {
            p.put(program, full());
        }
        return loggedIn(createAccount(createPackage("R1D1", p, org("R1", "D1"))));
    }

    private static Map<String, Object> allFields() {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("code", "ABC-100");
        b.put("name", "가상원본");
        b.put("gender", "여");
        b.put("age", 31);
        b.put("ageAsOf", "2026-01-01");
        b.put("foundDate", "2026-01-02");
        b.put("foundTime", "09:30");
        b.put("dateUnknown", false);
        b.put("classification1", "분류A");
        b.put("classification2", "분류B");
        b.put("place", "가상 장소");
        b.put("tool", "가상 도구");
        b.put("residence", "가상 거주지");
        b.put("teacher", "가상 교사");
        b.put("reason", "가상 사유");
        b.put("worker", "가상 담당");
        b.put("introducerId", "E-VIRT-1");
        b.put("introducerCode", "I-1");
        b.put("introducerName", "가상 인도자");
        b.put("introducerOrg", "가상 소속");
        b.put("regionCode", "R1");
        b.put("districtCode", "D1");
        b.put("className", "1반");
        b.put("employment", "직장인");
        b.put("stageId", "찾B");
        b.put("appointment", "다음 주 월요일");
        b.put("notes", "가상 메모");
        b.put("custom", Map.of("선호", "오전"));
        b.put("manpikDate", "2026-01-03");
        b.put("findADate", "2026-01-04");
        b.put("habBDate", "2026-01-05");
        b.put("habADate", "2026-01-06");
        b.put("youngTtaDate", "2026-01-07");
        b.put("bokshinDate", "2026-01-08");
        b.put("cardReceivedDate", "2026-01-09");
        b.put("centerRegisteredDate", "2026-01-10");
        return b;
    }

    private JsonNode create(TestClient client, Map<String, Object> body) throws Exception {
        return client.json(client.post("/api/programs/people/items", body).andExpect(status().isCreated()));
    }

    @Test
    void 원본_엑셀_필드를_모두_저장하고_조회하며_엑셀에도_나온다() throws Exception {
        TestClient user = admin();
        JsonNode saved = create(user, allFields());
        for (Map.Entry<String, Object> e : allFields().entrySet()) {
            if (e.getKey().equals("custom")) {
                assertThat(saved.get("custom").get("선호").asText()).isEqualTo("오전");
            } else if (e.getValue() instanceof Integer i) {
                assertThat(saved.get(e.getKey()).asInt()).as(e.getKey()).isEqualTo(i);
            } else if (e.getValue() instanceof Boolean b) {
                assertThat(saved.get(e.getKey()).asBoolean()).as(e.getKey()).isEqualTo(b);
            } else {
                assertThat(saved.get(e.getKey()).asText()).as(e.getKey()).isEqualTo(e.getValue());
            }
        }
        assertThat(saved.get("status").asText()).isEqualTo("active");
        assertThat(saved.get("rowVersion").asLong()).isEqualTo(1);
        assertThat(saved.get("registeredDate").asText()).isEqualTo("2026-01-02");   // 기존 화면 호환 별칭
        // PK 는 자동 증가 숫자 문자열이다(UUID 아님)
        assertThat(saved.get("id").asText()).matches("\\d+");
        JsonNode read = user.json(user.get("/api/programs/people/items/" + saved.get("id").asText()).andExpect(status().isOk()));
        assertThat(read).isEqualTo(saved);

        byte[] bytes = user.get("/api/programs/people/export/items.xlsx").andReturn().getResponse().getContentAsByteArray();
        try (XSSFWorkbook wb = new XSSFWorkbook(new ByteArrayInputStream(bytes))) {
            Sheet sheet = wb.getSheetAt(0);
            Row header = sheet.getRow(0);
            Row row = sheet.getRow(1);
            Map<String, String> byHeader = new HashMap<>();
            for (int i = 0; i < PeopleXlsx.HEADERS.size(); i++) {
                byHeader.put(header.getCell(i).getStringCellValue(), row.getCell(i) == null ? "" : row.getCell(i).toString());
            }
            assertThat(byHeader).containsEntry("찾은 장소", "가상 장소").containsEntry("교사", "가상 교사").containsEntry("인도자 이름", "가상 인도자")
                    .containsEntry("확정 일정", "다음 주 월요일").containsEntry("센터등록일", "2026-01-10").containsEntry("나이 기준일", "2026-01-01")
                    .containsEntry("찾은 시간", "09:30").containsEntry("반", "1반").containsEntry("직업", "직장인");
        }
    }

    @Test
    void 부분_수정은_보낸_필드만_바꾸고_나머지를_보존하며_null_과_빈문자열은_지운다() throws Exception {
        TestClient user = admin();
        JsonNode saved = create(user, allFields());
        String id = saved.get("id").asText();
        JsonNode after = user.json(user.put("/api/programs/people/items/" + id,
                Map.of("rowVersion", 1, "place", "바뀐 장소")).andExpect(status().isOk()));
        assertThat(after.get("place").asText()).isEqualTo("바뀐 장소");
        assertThat(after.get("rowVersion").asLong()).isEqualTo(2);
        for (String untouched : List.of("tool", "residence", "teacher", "notes", "introducerName", "habBDate", "appointment", "code", "stageId", "age")) {
            assertThat(after.get(untouched)).as(untouched).isEqualTo(saved.get(untouched));
        }
        // 명시 null 과 빈 문자열은 지움
        Map<String, Object> clear = new HashMap<>();
        clear.put("rowVersion", 2);
        clear.put("tool", null);
        clear.put("teacher", "  ");
        clear.put("age", null);
        clear.put("foundTime", "");
        JsonNode cleared = user.json(user.put("/api/programs/people/items/" + id, clear).andExpect(status().isOk()));
        assertThat(cleared.has("tool")).isFalse();
        assertThat(cleared.has("teacher")).isFalse();
        assertThat(cleared.has("age")).isFalse();
        assertThat(cleared.has("foundTime")).isFalse();
        assertThat(cleared.get("residence").asText()).isEqualTo("가상 거주지");   // 안 보낸 필드는 그대로
        // 필수(이름)는 지울 수 없다
        Map<String, Object> noName = new HashMap<>();
        noName.put("rowVersion", 3);
        noName.put("name", null);
        user.put("/api/programs/people/items/" + id, noName).andExpect(status().isBadRequest());
        // 단계·상태·삭제·연락처·알 수 없는 필드는 일반 수정으로 바꿀 수 없다
        for (String key : List.of("stageId", "status", "deleted", "phone", "password", "id", "legacyId")) {
            user.put("/api/programs/people/items/" + id, Map.of("rowVersion", 3, key, "x")).andExpect(status().isBadRequest());
        }
        // 값이 달라지지 않는 요청은 버전을 올리지 않는다
        user.put("/api/programs/people/items/" + id, Map.of("rowVersion", 3, "residence", "가상 거주지"))
                .andExpect(jsonPath("$.rowVersion").value(3));
    }

    @Test
    void ROW_VERSION_이_다르면_409_이고_없으면_400_이다() throws Exception {
        TestClient user = admin();
        String id = create(user, allFields()).get("id").asText();
        user.put("/api/programs/people/items/" + id, Map.of("name", "버전없음")).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("ROW_VERSION_REQUIRED"));
        user.put("/api/programs/people/items/" + id, Map.of("rowVersion", 1, "name", "먼저 저장")).andExpect(status().isOk());
        user.put("/api/programs/people/items/" + id, Map.of("rowVersion", 1, "name", "늦은 저장")).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("VERSION_CONFLICT"));
        user.patch("/api/programs/people/items/" + id, Map.of("rowVersion", 2, "name", "PATCH 도 같다")).andExpect(status().isOk());
        // 낡은 버전으로 단계 이동/탈락/삭제도 충돌
        user.post("/api/programs/people/items/" + id + "/stage", Map.of("stageId", "콜링", "rowVersion", 1)).andExpect(status().isConflict());
        user.post("/api/programs/people/items/" + id + "/dropout", Map.of("effectiveDate", "2026-01-05", "rowVersion", 1)).andExpect(status().isConflict());
        user.delete("/api/programs/people/items/" + id + "?rowVersion=1").andExpect(status().isConflict());
        user.get("/api/programs/people/items/" + id).andExpect(jsonPath("$.name").value("PATCH 도 같다"));
        user.put("/api/programs/people/items/" + id, Map.of("rowVersion", "abc", "name", "x")).andExpect(status().isBadRequest());
    }

    @Test
    void 같은_버전으로_동시에_저장하면_하나만_성공한다() throws Exception {
        TestClient user = admin();
        String id = create(user, allFields()).get("id").asText();
        Person current = memory.findPerson(id, DataScope.all()).orElseThrow();
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Callable<RecordRepository.Outcome>> jobs = new ArrayList<>();
            for (int i = 0; i < 8; i++) {
                String name = "동시" + i;
                jobs.add(() -> memory.updatePerson(id, Map.of(PersonField.NAME, name), RecordRepository.PhoneUpdate.NONE,
                        current.rowVersion(), DataScope.all()).outcome());
            }
            int ok = 0;
            int conflict = 0;
            for (Future<RecordRepository.Outcome> f : pool.invokeAll(jobs)) {
                switch (f.get()) {
                    case OK -> ok++;
                    case CONFLICT -> conflict++;
                    default -> throw new AssertionError();
                }
            }
            assertThat(ok).isEqualTo(1);
            assertThat(conflict).isEqualTo(7);
        } finally {
            pool.shutdown();
        }
    }

    @Test
    void 삭제는_상태코드를_바꾸지_않는_소프트_삭제이고_복구된다() throws Exception {
        TestClient user = admin();
        String id = create(user, allFields()).get("id").asText();
        user.delete("/api/programs/people/items/" + id + "?rowVersion=1").andExpect(status().isNoContent());
        JsonNode deleted = user.json(user.get("/api/programs/people/items/" + id).andExpect(status().isOk()));
        assertThat(deleted.get("deleted").asBoolean()).isTrue();
        assertThat(deleted.get("status").asText()).isEqualTo("active");      // 원래 상태 코드 그대로
        assertThat(deleted.get("stageId").asText()).isEqualTo("찾B");
        user.delete("/api/programs/people/items/" + id).andExpect(status().isNotFound());
        user.post("/api/programs/people/items/" + id + "/undelete?rowVersion=2", Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.deleted").value(false));
    }

    // ---- 연락처 ----

    private static final String PHONE = "010-1234-5678";

    @Test
    void 연락처는_저장되지만_응답_목록_엑셀_이력_어디에도_원문이_없고_끝4자리만_나온다() throws Exception {
        enableProgramDuringTest("history");
        TestClient user = admin();
        Map<String, Object> body = allFields();
        body.put("phone", PHONE);
        MvcStrings s = new MvcStrings();
        JsonNode saved = user.json(s.capture(user.post("/api/programs/people/items", body).andExpect(status().isCreated())));
        String id = saved.get("id").asText();
        assertThat(saved.get("phoneLast4").asText()).isEqualTo("5678");
        assertThat(saved.get("hasPhone").asBoolean()).isTrue();
        assertThat(saved.has("phone")).isFalse();

        // 서버 저장 값은 AES-256-GCM 봉투이고 원문이 아니다. AAD 는 AUTO_INCREMENT 확정 뒤의 신규 규칙이다.
        String envelope = memory.phoneEnvelopeOf(id).orElseThrow();
        assertThat(envelope).doesNotContain("1234").doesNotContain("010");
        assertThat(envelope).contains("\"aad\":\"SMOA:v1:memory:TGMSTR:db:" + id + ":PHONE_ENC\"");
        assertThat(vault.openForVerification(envelope, List.of(ContactVault.newAad("memory", id)))).isEqualTo(PHONE);
        org.assertj.core.api.Assertions.assertThatThrownBy(
                () -> vault.openForVerification(envelope, List.of(ContactVault.newAad("memory", "999999"))))
                .isInstanceOf(com.smoa.crypto.ContactCrypto.ContactCryptoException.class);

        s.capture(user.get("/api/programs/people/items?q=가상원본"));
        s.capture(user.get("/api/programs/people/items/" + id));
        s.capture(user.get("/api/programs/history/items?personId=" + id));
        s.capture(user.get("/api/programs/people/items?phoneLast4=5678").andExpect(jsonPath("$.length()").value(1)));
        user.get("/api/programs/people/items?phoneLast4=0000").andExpect(jsonPath("$.length()").value(0));
        user.get("/api/programs/people/items?phoneLast4=12").andExpect(status().isBadRequest());
        byte[] xlsx = user.get("/api/programs/people/export/items.xlsx").andReturn().getResponse().getContentAsByteArray();
        try (XSSFWorkbook wb = new XSSFWorkbook(new ByteArrayInputStream(xlsx))) {
            StringBuilder all = new StringBuilder();
            wb.getSheetAt(0).forEach(row -> row.forEach(cell -> all.append(cell.toString()).append('|')));
            assertThat(all.toString()).contains("5678").doesNotContain("1234-5678").doesNotContain("01012345678").doesNotContain(PHONE);
        }
        for (String text : s.texts) {
            assertThat(text).doesNotContain(PHONE).doesNotContain("01012345678").doesNotContain("1234-5678").doesNotContain("SMOA:v1");
        }

        // 연락처 변경 API: 새 봉투, 끝 네 자리 갱신, 이력에는 변경 사실만
        JsonNode changed = user.json(user.put("/api/programs/people/items/" + id + "/phone", Map.of("rowVersion", 1, "phone", "+82 10 9999 0001"))
                .andExpect(status().isOk()));
        assertThat(changed.get("phoneLast4").asText()).isEqualTo("0001");
        assertThat(changed.get("rowVersion").asLong()).isEqualTo(2);
        String envelope2 = memory.phoneEnvelopeOf(id).orElseThrow();
        assertThat(envelope2).isNotEqualTo(envelope);
        assertThat(vault.openForVerification(envelope2, List.of(ContactVault.newAad("memory", id)))).isEqualTo("+82 10 9999 0001");
        user.put("/api/programs/people/items/" + id + "/phone", Map.of("rowVersion", 1, "phone", PHONE)).andExpect(status().isConflict());
        user.put("/api/programs/people/items/" + id + "/phone", Map.of("rowVersion", 2, "phone", "abcd")).andExpect(status().isBadRequest());
        user.put("/api/programs/people/items/" + id + "/phone", Map.of("rowVersion", 2, "phone", PHONE, "extra", 1)).andExpect(status().isBadRequest());
        String history = user.get("/api/programs/history/items?personId=" + id).andReturn().getResponse().getContentAsString();
        assertThat(history).contains("PHONE_CHANGED").doesNotContain("9999").doesNotContain("0001").doesNotContain("5678");
        JsonNode cleared = user.json(user.put("/api/programs/people/items/" + id + "/phone", java.util.Collections.singletonMap("rowVersion", 2))
                .andExpect(status().isOk()));
        assertThat(cleared.get("hasPhone").asBoolean()).isFalse();
        assertThat(cleared.has("phoneLast4")).isFalse();
        assertThat(memory.phoneEnvelopeOf(id)).isEmpty();
    }

    /** 응답 본문 문자열을 모아 두고 원문 연락처가 없음을 한꺼번에 확인한다. */
    private static final class MvcStrings {
        final List<String> texts = new ArrayList<>();

        org.springframework.test.web.servlet.ResultActions capture(org.springframework.test.web.servlet.ResultActions result)
                throws Exception {
            texts.add(result.andReturn().getResponse().getContentAsString());
            return result;
        }
    }

    @Test
    void 연락처_수정은_다른_구역_사용자에게는_404() throws Exception {
        TestClient all = admin();
        Map<String, Object> other = allFields();
        other.put("regionCode", "R2");
        other.put("districtCode", "D1");
        String id = create(all, other).get("id").asText();
        TestClient r1 = r1("people");
        r1.put("/api/programs/people/items/" + id + "/phone", Map.of("rowVersion", 1, "phone", PHONE)).andExpect(status().isNotFound());
    }

    // ---- 구역 미지정 ----

    @Test
    void 구역이_없는_자료는_ALL_범위에서만_보인다() throws Exception {
        Map<PersonField, Object> values = new java.util.EnumMap<>(PersonField.class);
        values.put(PersonField.NAME, "구역없음");
        values.put(PersonField.STAGE, "찾B");
        values.put(PersonField.STATUS, "active");
        values.put(PersonField.DELETED, false);
        Person orphan = memory.insertPerson(new Person(null, null, values, null, false, 0, null, null));
        TestClient all = admin();
        all.get("/api/programs/people/items?q=구역없음").andExpect(jsonPath("$.length()").value(1));
        all.get("/api/programs/people/items/" + orphan.id()).andExpect(status().isOk());
        TestClient org = r1("people");
        org.get("/api/programs/people/items?q=구역없음").andExpect(jsonPath("$.length()").value(0));
        org.get("/api/programs/people/items/" + orphan.id()).andExpect(status().isNotFound());
        org.put("/api/programs/people/items/" + orphan.id(), Map.of("rowVersion", 1, "name", "탈취")).andExpect(status().isNotFound());
    }

    // ---- 활동 ----

    @Test
    void 독립_활동은_대상자_없이_구역_범위로_등록_조회되고_집계가_구분된다() throws Exception {
        TestClient user = r1("people", "activities");
        String personId = create(user, allFields()).get("id").asText();
        JsonNode standalone = user.json(user.post("/api/programs/activities/items", Map.of("regionCode", "R1", "districtCode", "D1",
                "date", "2026-01-02", "startTime", "10:00", "endTime", "11:30", "type", "지역 봉사", "worker", "가상활동자",
                "sessionKey", "S-1", "place", "회관", "memo", "독립 활동")).andExpect(status().isCreated()));
        assertThat(standalone.get("standalone").asBoolean()).isTrue();
        assertThat(standalone.has("personId")).isFalse();
        assertThat(standalone.get("minutes").asInt()).isEqualTo(90);               // 시작·종료에서 계산
        assertThat(standalone.get("startTime").asText()).isEqualTo("10:00");
        assertThat(standalone.get("sessionKey").asText()).isEqualTo("S-1");
        user.post("/api/programs/activities/items", Map.of("personId", personId, "date", "2026-01-03", "type", "방문", "minutes", 40, "worker", "가상활동자"))
                .andExpect(status().isCreated());
        user.get("/api/programs/activities/items").andExpect(jsonPath("$.length()").value(2));
        user.get("/api/programs/activities/items?standalone=true").andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].memo").value("독립 활동"));
        user.get("/api/programs/activities/items?standalone=false").andExpect(jsonPath("$.length()").value(1));
        user.get("/api/programs/activities/items?personId=" + personId).andExpect(jsonPath("$.length()").value(1));
        user.get("/api/programs/activities/summary").andExpect(jsonPath("$.personActivities.count").value(1))
                .andExpect(jsonPath("$.personActivities.minutes").value(40))
                .andExpect(jsonPath("$.standaloneActivities.count").value(1))
                .andExpect(jsonPath("$.standaloneActivities.minutes").value(90));
        // 독립 활동 생성은 구역이 필요하고 범위 밖이면 403
        user.post("/api/programs/activities/items", Map.of("date", "2026-01-02", "type", "x")).andExpect(status().isBadRequest());
        user.post("/api/programs/activities/items", Map.of("regionCode", "R2", "districtCode", "D1", "date", "2026-01-02", "type", "x"))
                .andExpect(status().isForbidden());
        // 다른 구역 사용자는 독립 활동도 볼 수 없다
        TestClient other = loggedIn(createAccount(createPackage("R2활동", perms("activities", full()), org("R2", "D1"))));
        other.get("/api/programs/activities/items").andExpect(jsonPath("$.length()").value(0));
        other.get("/api/programs/activities/summary").andExpect(jsonPath("$.total").value(0));
    }

    @Test
    void 활동_수정은_ROW_VERSION_과_구역_범위를_따르고_삭제는_소프트_삭제다() throws Exception {
        TestClient user = r1("people", "activities");
        String id = user.json(user.post("/api/programs/activities/items", Map.of("regionCode", "R1", "districtCode", "D1", "date", "2026-01-02",
                "type", "방문", "memo", "원본", "place", "장소A")).andExpect(status().isCreated())).get("id").asText();
        user.put("/api/programs/activities/items/" + id, Map.of("memo", "버전 없음")).andExpect(status().isBadRequest());
        JsonNode updated = user.json(user.put("/api/programs/activities/items/" + id, Map.of("rowVersion", 1, "memo", "수정")).andExpect(status().isOk()));
        assertThat(updated.get("memo").asText()).isEqualTo("수정");
        assertThat(updated.get("place").asText()).isEqualTo("장소A");              // 보내지 않은 필드 보존
        assertThat(updated.get("rowVersion").asLong()).isEqualTo(2);
        user.put("/api/programs/activities/items/" + id, Map.of("rowVersion", 1, "memo", "낡음")).andExpect(status().isConflict());
        user.put("/api/programs/activities/items/" + id, Map.of("rowVersion", 2, "regionCode", "R2", "districtCode", "D1")).andExpect(status().isForbidden());
        user.put("/api/programs/activities/items/" + id, Map.of("rowVersion", 2, "personId", "1")).andExpect(status().isBadRequest());
        user.delete("/api/programs/activities/items/" + id + "?rowVersion=2").andExpect(status().isNoContent());
        user.get("/api/programs/activities/items").andExpect(jsonPath("$.length()").value(0));
        user.get("/api/programs/activities/items/" + id).andExpect(status().isNotFound());
    }

    // ---- 단계/이력 ----

    @Test
    void 단계_이동_시각은_한국_업무시각_분단위_00초이고_기록시각은_UTC_Z_이다() throws Exception {
        enableProgramDuringTest("history");
        TestClient user = admin();
        String id = create(user, allFields()).get("id").asText();
        user.post("/api/programs/people/items/" + id + "/stage", Map.of("stageId", "콜링", "effectiveDate", "2026-01-05",
                "effectiveTime", "09:30", "reason", "연결", "rowVersion", 1)).andExpect(status().isOk());
        JsonNode history = user.json(user.get("/api/programs/history/items?personId=" + id));
        JsonNode stage = null;
        for (JsonNode h : history) {
            if ("STAGE_CHANGED".equals(h.get("type").asText())) {
                stage = h;
            }
        }
        assertThat(stage).isNotNull();
        assertThat(stage.get("effectiveAt").asText()).isEqualTo("2026-01-05T09:30:00");
        assertThat(stage.get("effectiveDate").asText()).isEqualTo("2026-01-05");
        assertThat(stage.get("timeUnknown").asBoolean()).isFalse();
        assertThat(stage.get("recordedAt").asText()).endsWith("Z").matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z");
        user.post("/api/programs/people/items/" + id + "/stage", Map.of("stageId", "만픽", "effectiveTime", "25:99")).andExpect(status().isBadRequest());
        // 날짜만 주면 시각 미상
        user.post("/api/programs/people/items/" + id + "/stage", Map.of("stageId", "만픽", "effectiveDate", "2026-01-06", "rowVersion", 2)).andExpect(status().isOk());
        JsonNode again = user.json(user.get("/api/programs/history/items?personId=" + id));
        boolean unknown = false;
        for (JsonNode h : again) {
            if ("만픽".equals(h.path("toValue").asText())) {
                unknown = h.get("timeUnknown").asBoolean() && h.get("effectiveAt").asText().equals("2026-01-06T00:00:00");
            }
        }
        assertThat(unknown).isTrue();
    }

    @Test
    void 단계는_공통코드_STAGE_그룹에서_읽고_옵션에_원본_코드가_나온다() throws Exception {
        TestClient user = admin();
        JsonNode options = user.json(user.get("/api/programs/people/options").andExpect(status().isOk()));
        assertThat(options.get("stages")).isNotEmpty();
        assertThat(options.get("stageItems").get(0).get("label").asText()).isNotBlank();
        assertThat(options.get("statuses")).extracting(JsonNode::asText).containsExactly("active", "dropped");
        Map<String, Object> bad = allFields();
        bad.put("stageId", "없는단계");
        user.post("/api/programs/people/items", bad).andExpect(status().isBadRequest());
    }

    @Test
    void 이름_연락처_식별번호가_같아도_별개_대상자로_등록된다() throws Exception {
        TestClient user = admin();
        Map<String, Object> body = allFields();
        body.put("phone", PHONE);
        String a = create(user, body).get("id").asText();
        String b = create(user, body).get("id").asText();
        assertThat(a).isNotEqualTo(b);
        user.get("/api/programs/people/items?q=가상원본").andExpect(jsonPath("$.length()").value(2));
    }
}
