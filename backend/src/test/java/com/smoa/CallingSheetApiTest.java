package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.ByteArrayInputStream;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import com.fasterxml.jackson.databind.JsonNode;
import com.smoa.callingsheet.CallingSheetAad;
import com.smoa.callingsheet.CallingSheetXlsx;
import com.smoa.callingsheet.memory.MemoryCallingSheetRepository;
import com.smoa.crypto.ContactVault;
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

class CallingSheetApiTest extends ApiTestBase {

    private static final String BASE = "/api/programs/callingSheet";
    private static final String ITEMS = BASE + "/items";
    private static final String TEST_PHONE = "010-0000-2468";

    @Autowired
    private MemoryCallingSheetRepository sheets;
    @Autowired
    private ContactVault vault;

    @BeforeEach
    void resetSheets() {
        sheets.clear();
    }

    @Test
    void 목록_차트_다운로드와_단건에서_지역과_구역_권한을_공통_적용한다() throws Exception {
        TestClient admin = loggedInAdmin();
        String visible = create(admin, "R1", "가상대상자").path("id").asText();
        String hidden = create(admin, "R2", "가상대상자").path("id").asText();
        assertThat(visible).isNotEqualTo(hidden);
        TestClient restricted = loggedIn(createAccount(createPackage("구역", perms("callingSheet", full()), org("R1", "D1"))));
        restricted.get("/pages/callingSheet.html").andExpect(status().isOk());
        restricted.get(BASE + "/options").andExpect(status().isOk())
                .andExpect(jsonPath("$.districts.length()").value(1));
        restricted.get(ITEMS + "?phoneLast4=2468&roundCode=1&roundState=has&size=1").andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(1)).andExpect(jsonPath("$.items[0].id").value(visible));
        restricted.get(BASE + "/stats?phoneLast4=2468&roundCode=1&roundState=has").andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(1)).andExpect(jsonPath("$.manpik").value(1))
                .andExpect(jsonPath("$.byDistrict[0].regionCode").value("R1"));
        restricted.get(ITEMS + "?regionCode=R2&districtCode=D1").andExpect(jsonPath("$.total").value(0));
        restricted.get(ITEMS + "/" + hidden).andExpect(status().isNotFound());
        restricted.patch(ITEMS + "/" + hidden, Map.of("rowVersion", 1, "notes", "금지"))
                .andExpect(status().isNotFound());
        restricted.patch(ITEMS + "/" + visible, Map.of("rowVersion", 1, "regionCode", "R2"))
                .andExpect(status().isForbidden());

        byte[] exported = restricted.get(BASE + "/export/items.xlsx?roundCode=1&roundState=has")
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray();
        try (var workbook = new XSSFWorkbook(new ByteArrayInputStream(exported))) {
            var main = workbook.getSheet("콜링시트");
            assertThat(main.getPhysicalNumberOfRows()).isEqualTo(2);
            Row row = main.getRow(1);
            assertThat(row.getCell(0).getStringCellValue()).isEqualTo(visible);
            assertThat(row.getCell(6).getStringCellValue()).isEqualTo("2468");
            assertThat(row.getCell(11).getStringCellValue()).isEqualTo("2000년생");
            assertThat(row.getCell(14).getStringCellValue()).doesNotContain(TEST_PHONE);
            assertThat(main.getRow(0).getLastCellNum()).isEqualTo((short) CallingSheetXlsx.HEADERS.size());
            assertThat(workbook.getSheet("회차").getPhysicalNumberOfRows()).isEqualTo(3);
        }

        TestClient readOnly = loggedIn(createAccount(createPackage("조회", perms("callingSheet", ro()), org("R1", "D1"))));
        readOnly.get(BASE + "/options").andExpect(status().isOk())
                .andExpect(jsonPath("$.canWrite").value(false)).andExpect(jsonPath("$.accounts").doesNotExist());
        readOnly.get(ITEMS + "/" + visible).andExpect(status().isOk());
        readOnly.get(ITEMS + "?trash=true").andExpect(status().isForbidden());
        readOnly.get(BASE + "/export/items.xlsx").andExpect(status().isForbidden());
        readOnly.post(ITEMS, Map.of("targetName", "쓰기 거부")).andExpect(status().isForbidden());
    }

    @Test
    void 연락처를_행에_결합해_봉인하고_버전_검사와_회차_삭제_휴지통_복구를_적용한다() throws Exception {
        TestClient admin = loggedInAdmin();
        JsonNode created = create(admin, "R1", "가상 연락처 검증");
        String id = created.path("id").asText();
        assertThat(created.toString()).doesNotContain(TEST_PHONE, "sourceEnc", "phoneEnc");
        var stored = sheets.raw(Long.parseLong(id)).orElseThrow();
        assertThat(stored.phoneLast4()).isEqualTo("2468");
        assertThat(stored.sourceEnc()).contains("notes").doesNotContain(TEST_PHONE, "01000002468");
        assertThat(stored.notes()).doesNotContain(TEST_PHONE);
        String envelope = sheets.phoneForTest(Long.parseLong(id)).orElseThrow().envelope();
        assertThat(envelope).doesNotContain(TEST_PHONE);
        assertThat(vault.openForVerification(envelope, List.of(CallingSheetAad.phone(sheets.libraryId(), Long.parseLong(id)))))
                .isEqualTo(TEST_PHONE);
        assertThat(sheets.auditEntries().getFirst().afterJson()).doesNotContain(TEST_PHONE, "가상메모", "가상 연락처 검증");

        String url = ITEMS + "/" + id;
        admin.patch(url, Map.of("rowVersion", 1, "rounds", List.of(Map.of("code", "1", "remove", true))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.rowVersion").value(2))
                .andExpect(jsonPath("$.rounds[0].code").value("추가"));
        admin.patch(url, Map.of("rowVersion", 1, "notes", "다른 변경")).andExpect(status().isConflict());
        admin.delete(url + "?rowVersion=2").andExpect(status().isOk()).andExpect(jsonPath("$.deleted").value(true));
        admin.get(url).andExpect(status().isNotFound());
        admin.get(ITEMS + "?trash=true").andExpect(jsonPath("$.total").value(1));
        admin.post(url + "/undelete?rowVersion=3", Map.of()).andExpect(status().isOk())
                .andExpect(jsonPath("$.rowVersion").value(4)).andExpect(jsonPath("$.deleted").value(false));
    }

    @Test
    void 일괄_변경에서_하나의_버전이_만료되면_다른_행도_변하지_않는다() throws Exception {
        TestClient admin = loggedInAdmin();
        String first = create(admin, "R1", "첫 행").path("id").asText();
        String second = create(admin, "R1", "둘째 행").path("id").asText();
        var updates = List.of(Map.of("id", first, "rowVersion", 1, "targetName", "변경"),
                Map.of("id", second, "rowVersion", 99, "targetName", "버전 만료"));
        admin.post(ITEMS + "/batch", Map.of("items", updates)).andExpect(status().isConflict());
        admin.get(ITEMS + "/" + first).andExpect(jsonPath("$.targetName").value("첫 행"));
    }

    private static JsonNode create(TestClient client, String region, String name) throws Exception {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("targetName", name);
        values.put("regionCode", region);
        values.put("districtCode", "D1");
        values.put("callStatus", "신규");
        values.put("foundDate", "2026-11-01");
        values.put("manpikConfirmedAt", "2026-11-29T16:00");
        values.put("ageText", "2000년생");
        values.put("phone", TEST_PHONE);
        values.put("notes", "가상메모 " + TEST_PHONE);
        values.put("rounds", List.of(Map.of("code", "1", "callerName", "가상 담당자"),
                Map.of("code", "추가", "label", "추가 회차", "callerName", "가상 추가 담당자")));
        return client.json(client.post(ITEMS, values).andExpect(status().isCreated()));
    }
}
