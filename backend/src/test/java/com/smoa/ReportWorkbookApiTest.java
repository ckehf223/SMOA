package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.ByteArrayInputStream;
import java.util.List;
import java.util.Map;

import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;

import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

class ReportWorkbookApiTest extends ApiTestBase {

    @Test
    void 내보내기_권한과_구역을_검사하고_엑셀에는_마스킹한_값을_쓴다() throws Exception {
        enableProgramDuringTest("daily");
        TestClient user = loggedIn(createAccount(createPackage("일보", perms("daily", full()), org("R1", "D1"))));
        user.get("/api/programs/daily/options").andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].regionCode").value("R1")).andExpect(jsonPath("$[0].districtCode").value("D1"));

        String path = "/api/programs/daily/export/conversion.xlsx";
        user.post(path, conversion("R2")).andExpect(status().isForbidden());
        byte[] data = user.post(path, conversion("R1")).andExpect(status().isOk()).andReturn().getResponse()
                .getContentAsByteArray();
        try (XSSFWorkbook workbook = new XSSFWorkbook(new ByteArrayInputStream(data))) {
            assertThat(workbook.getNumberOfSheets()).isEqualTo(3);
            var row = workbook.getSheet("활동자").getRow(1);
            assertThat(row.getCell(3).getStringCellValue()).contains("1234").doesNotContain("010-0000");
        }

        TestClient readOnly = loggedIn(createAccount(createPackage("미리보기", perms("daily", ro()), org("R1", "D1"))));
        readOnly.post(path, conversion("R1")).andExpect(status().isForbidden());
    }

    private static Map<String, Object> conversion(String region) {
        return Map.of("activities", List.of(Map.of("regionCode", region, "districtCode", "D1",
                "reportDate", "2026-11-27", "name", "가상 010-0000-1234", "status", 1)), "people", List.of());
    }
}
