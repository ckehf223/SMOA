package com.smoa.analysis;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.ByteArrayInputStream;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import org.apache.ibatis.builder.xml.XMLMapperBuilder;
import org.apache.ibatis.session.Configuration;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;

import com.smoa.analysis.AnalysisData.Filter;
import com.smoa.permission.DistrictKey;
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

class AnalysisFeatureTest extends ApiTestBase {
    private static final String FIND = "/api/programs/findingStats";
    private static final String DIAG = "/api/programs/diagnostics";

    @Test
    void 주관_집계는_자정과_정각_보고를_해석하고_다른_지역의_구역은_제외한다() throws Exception {
        TestClient admin = loggedInAdmin();
        person(admin, "가상 A", "R1", "2026-01-05", "00:00", "2026-01-10");
        person(admin, "가상 B", "R1", "2026-01-05", "00:25", "2026-01-14");
        person(admin, "가상 C", "R1", "2026-01-05", "01:12", "2026-01-06");
        person(admin, "가상 D", "R2", "2026-01-05", "00:00", "2026-01-06");
        activity(admin, "R1", "가상 주관", "2026-01-04", "23:40", "00:30", "주관자");
        activity(admin, "R1", "가상 미주관", "2026-01-05", "00:00", "00:50", "주관자 아님");
        activity(admin, "R2", "가상 외부", "2026-01-05", "00:10", "00:50", "주관자");
        TestClient scoped = loggedIn(createAccount(createPackage("finding", perms("findingStats", full(), "diagnostics", ro()), org("R1", "D1"))));
        String query = "?from=2026-01-05&to=2026-01-05";
        scoped.get(FIND + "/options").andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(1));
        scoped.get(FIND + "/data/summary" + query).andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(3)).andExpect(jsonPath("$.linked").value(2))
                .andExpect(jsonPath("$.gaps.noSession").value(1)).andExpect(jsonPath("$.leaders.length()").value(1))
                .andExpect(jsonPath("$.leaders[0].minutes").value(30)).andExpect(jsonPath("$.hours[0].total").value(2))
                .andExpect(jsonPath("$.leaders[0].sessions[0].start").value("2026-01-05T00:00:00"));
        scoped.get(FIND + "/data/summary" + query + "&regionCode=R2&districtCode=D1").andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(0));
        var bytes = scoped.get(FIND + "/export/summary.xlsx" + query).andExpect(status().isOk())
                .andReturn().getResponse().getContentAsByteArray();
        try (var book = new XSSFWorkbook(new ByteArrayInputStream(bytes))) {
            assertThat(book.getSheet("주관자별").getPhysicalNumberOfRows()).isEqualTo(2);
            assertThat(book.getSheet("시간대별").getPhysicalNumberOfRows()).isEqualTo(25);
        }
        scoped.get(DIAG + "/data/summary?anchor=2026-01-08&kind=week").andExpect(status().isOk())
                .andExpect(jsonPath("$.periods.length()").value(3)).andExpect(jsonPath("$.periods[0].roadFindings").value(3))
                .andExpect(jsonPath("$.periods[0].cohorts[0].completed").value(3))
                .andExpect(jsonPath("$.periods[0].cohorts[0].reached").value(2));
        scoped.get(DIAG + "/export/summary.xlsx?anchor=2026-01-08").andExpect(status().isForbidden());
    }

    @Test
    void 여러_주관자가_겹치면_귀속하지_않고_진행중_기간은_같은_일수로_비교한다() {
        LocalDate date = LocalDate.of(2026, 1, 5);
        var periods = DiagnosticsAnalysis.periods(date, date, false);
        assertThat(periods).containsExactly(new DiagnosticsAnalysis.Period(date.minusDays(1), date),
                new DiagnosticsAnalysis.Period(date.minusDays(8), date.minusWeeks(1)),
                new DiagnosticsAnalysis.Period(date.minusDays(15), date.minusWeeks(2)));
        var found = new AnalysisData.Finding(date, java.time.LocalTime.of(16, 0), "R1", "D1", "장소", "노방", null, null);
        var a = new AnalysisData.Activity(date, java.time.LocalTime.of(16, 0), java.time.LocalTime.of(16, 20), "R1", "D1",
                "1", null, "활동자", "직장인", "장소", null, "주관자");
        var b = new AnalysisData.Activity(date, java.time.LocalTime.of(16, 30), java.time.LocalTime.of(16, 50), "R1", "D1",
                "2", null, "활동자", "학생", "장소", null, "주관자");
        var result = FindingAnalysis.summarize(new Filter(date, date, null, null, true),
                new AnalysisData.Rows(List.of(found), List.of(a, b)), Map.of(), "직장인");
        assertThat(result.total()).isEqualTo(1);
        assertThat(result.linked()).isZero();
        assertThat(result.gaps().ambiguous()).isEqualTo(1);
        assertThat(result.leaders()).hasSize(1);
    }

    @Test
    void 미이관_스냅샷은_중복_집계를_방지하고_SQL_범위와_날짜를_바인딩한다() throws Exception {
        String resource = "mapper/analysis/AnalysisMapper.xml";
        Configuration config = new Configuration();
        try (var input = getClass().getClassLoader().getResourceAsStream(resource)) {
            assertThat(input).isNotNull();
            new XMLMapperBuilder(input, config, resource, config.getSqlFragments()).parse();
        }
        var ns = AnalysisMapper.class.getName() + ".";
        var sqlParams = Map.of("library", "lib", "filter", new Filter(LocalDate.of(2026, 1, 1), LocalDate.of(2026, 1, 31), "R1", "D1", true),
                "districts", List.of(new DistrictKey("R1", "D1")), "unassigned", false);
        var findings = config.getMappedStatement(ns + "selectFindings").getBoundSql(sqlParams).getSql();
        var activity = config.getMappedStatement(ns + "selectActivities").getBoundSql(sqlParams).getSql();
        for (String sql : List.of(findings, activity)) assertThat(sql).contains("S.LIB_ID = ?", "OR (S.ORG_MSTR_CODE = ? AND S.ORG_CODE = ?)")
                .doesNotContain("PHONE_ENC", "SOURCE_ENC");
        assertThat(findings).contains("ROW_NUMBER() OVER", "NOT EXISTS", "T.TGT_ID = D.TGT_ID", "S.FOUND_DATE >= ?");
        assertThat(activity).contains("DATE_SUB(?, INTERVAL 1 DAY)");
    }

    private static void person(TestClient client, String name, String region, String find, String time, String manpik) throws Exception {
        client.post("/api/programs/people/items", Map.of("name", name, "regionCode", region, "districtCode", "D1", "stageId", "찾B",
                "foundDate", find, "foundTime", time, "classification2", "노방", "manpikDate", manpik)).andExpect(status().isCreated());
    }

    private static void activity(TestClient client, String region, String worker, String date, String start, String end, String memo) throws Exception {
        client.post("/api/programs/activities/items", Map.of("date", date, "regionCode", region, "districtCode", "D1", "worker", worker,
                "startTime", start, "endTime", end, "type", "노방", "classification2", "노방", "memo", memo)).andExpect(status().isCreated());
    }
}
