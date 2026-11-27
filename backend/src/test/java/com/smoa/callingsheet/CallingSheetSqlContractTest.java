package com.smoa.callingsheet;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.apache.ibatis.builder.xml.XMLMapperBuilder;
import org.apache.ibatis.mapping.BoundSql;
import org.apache.ibatis.mapping.ParameterMapping;
import org.apache.ibatis.session.Configuration;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import com.smoa.callingsheet.persistence.CallingSheetMapper;

class CallingSheetSqlContractTest {
    private static final String RESOURCE = "mapper/callingsheet/CallingSheetMapper.xml";
    private static final String NAMESPACE = CallingSheetMapper.class.getName() + ".";
    private static final Configuration CONFIG = new Configuration();

    @BeforeAll
    static void loadMapper() throws Exception {
        try (InputStream stream = CallingSheetSqlContractTest.class.getClassLoader().getResourceAsStream(RESOURCE)) {
            assertThat(stream).isNotNull();
            new XMLMapperBuilder(stream, CONFIG, RESOURCE, CONFIG.getSqlFragments()).parse();
        }
    }

    @Test
    void 목록과_집계는_같은_복합_범위와_필터를_바인딩하고_연락처_암호문을_읽지_않는다() {
        for (Method method : CallingSheetMapper.class.getDeclaredMethods()) {
            assertThat(CONFIG.hasStatement(NAMESPACE + method.getName())).as(method.getName()).isTrue();
        }
        Map<String, Object> params = new HashMap<>();
        params.put("libId", "library-for-test");
        params.put("scopeUnassigned", false);
        params.put("districts", List.of(Map.of("regionCode", "R1", "districtCode", "D1")));
        params.put("f", Map.of("deleted", "N", "roundCode", "4", "roundState", "none", "manpik", "any",
                "qLike", "%literal!_%", "phoneLast4", "2468", "sort", "district", "desc", true));
        params.put("offset", 0);
        params.put("limit", 25);

        for (String name : List.of("selectSheets", "countSheets", "selectStatsSummary", "selectStatsByStatus",
                "selectStatsByResult", "selectStatsByDistrict")) {
            BoundSql bound = sql(name, params);
            assertThat(normalized(bound)).contains("S.LIB_ID = ?", "S.DEL_IND = ?",
                    "OR (S.ORG_MSTR_CODE = ? AND S.ORG_CODE = ?)", "NOT EXISTS", "S.PHONE_LAST4 = ?", "ESCAPE '!'",
                    "S.MANPIK_CONFIRMED_AT IS NOT NULL").doesNotContain("PHONE_ENC", "SOURCE_ENC", "2468", "%literal");
            assertThat(parameters(bound)).contains("f.roundCode", "f.phoneLast4", "f.qLike");
        }
        assertThat(normalized(sql("selectSheets", params))).containsPattern("ORDER BY S\\.ORG_MSTR_CODE DESC *, S\\.ORG_CODE DESC");
        params.put("districts", List.of());
        assertThat(normalized(sql("selectSheets", params))).contains("AND (1 = 0 )");
    }

    @Test
    void 버전과_범위가_맞는_행만_수정하고_아직_변경하지_않은_연락처를_건드리지_않는다() {
        var params = new HashMap<String, Object>();
        params.put("changed", List.of(SheetField.NOTES).stream().map(SheetField::key).toList());
        params.put("phoneChange", false);
        params.put("sourceChange", true);
        params.put("scopeUnassigned", true);
        params.put("districts", List.of());
        BoundSql bound = sql("updateSheet", params);
        assertThat(normalized(bound)).contains("NOTES = ?", "SOURCE_ENC = ?", "ROW_VERSION = ROW_VERSION + 1",
                "S.LIB_ID = ?", "S.SHEET_ID = ?", "S.DEL_IND = 'N'", "S.ROW_VERSION = ?", "S.ORG_CODE IS NULL")
                .doesNotContain("PHONE_ENC", "TARGET_NAME");
        assertThat(parameters(bound)).contains("notes", "sourceEnc", "expectedVersion");
    }

    private static BoundSql sql(String name, Map<String, Object> args) {
        return CONFIG.getMappedStatement(NAMESPACE + name).getBoundSql(args);
    }

    private static String normalized(BoundSql sql) {
        return sql.getSql().replaceAll("\\s+", " ").trim();
    }

    private static List<String> parameters(BoundSql sql) {
        return sql.getParameterMappings().stream().map(ParameterMapping::getProperty).toList();
    }
}
