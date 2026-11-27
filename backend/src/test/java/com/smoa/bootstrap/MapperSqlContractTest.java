package com.smoa.bootstrap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.io.InputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.apache.ibatis.builder.xml.XMLMapperBuilder;
import org.apache.ibatis.mapping.BoundSql;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.mapping.ParameterMapping;
import org.apache.ibatis.mapping.ResultMap;
import org.apache.ibatis.mapping.ResultMapping;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import com.smoa.account.persistence.AccountMapper;
import com.smoa.afterreport.AfterReportMapper;
import com.smoa.analysis.AnalysisMapper;
import com.smoa.callingsheet.persistence.CallingSheetMapper;
import com.smoa.module.mapper.AnalyticsMapper;
import com.smoa.module.mapper.CallingMapper;
import com.smoa.module.mapper.RecordsMapper;
import com.smoa.organization.persistence.BusinessMapper;
import com.smoa.permission.persistence.PackageMapper;
import com.smoa.program.persistence.ProgramMapper;
import com.smoa.records.ActivityField;
import com.smoa.records.PersonField;
import com.smoa.reference.persistence.ReferenceMapper;
import com.smoa.settings.persistence.LibrarySettingsMapper;

/**
 * DB 에 연결하지 않고 실제 mapper XML 을 MyBatis 로 파싱해 검증한다(BoundSql 만 렌더링, 어떤 SQL 도 실행하지 않는다).
 * - Mapper 계약(모든 메서드에 statement, 필수 resultMap) / 미이식 모듈에는 statement 가 없음(가짜 SQL 금지)
 * - resultMap 컬럼과 SELECT 별칭 일치, #{} 바인딩, LIB_ID 조건, 구역 복합키 OR 괄호, 부분 UPDATE
 */
class MapperSqlContractTest {

    private static final String[] XML = {"mapper/account/AccountMapper.xml", "mapper/permission/PackageMapper.xml",
            "mapper/program/ProgramMapper.xml", "mapper/reference/ReferenceMapper.xml", "mapper/module/RecordsMapper.xml",
            "mapper/module/AnalyticsMapper.xml", "mapper/module/CallingMapper.xml", "mapper/module/GoalsMapper.xml",
            "mapper/module/ImportsMapper.xml", "mapper/module/OrganizationMapper.xml", "mapper/module/SocialingMapper.xml",
            "mapper/organization/BusinessMapper.xml", "mapper/callingsheet/CallingSheetMapper.xml",
            "mapper/analysis/AnalysisMapper.xml", "mapper/settings/LibrarySettingsMapper.xml",
            "mapper/afterreport/AfterReportMapper.xml"};

    private static Configuration configuration;

    @BeforeAll
    static void load() throws Exception {
        configuration = new Configuration();
        for (String resource : XML) {
            try (InputStream in = MapperSqlContractTest.class.getClassLoader().getResourceAsStream(resource)) {
                assertThat(in).as(resource).isNotNull();
                new XMLMapperBuilder(in, configuration, resource, configuration.getSqlFragments()).parse();
            }
        }
    }

    private static String sql(String statementId, Object param) {
        return bound(statementId, param).getSql().replaceAll("\\s+", " ").trim();
    }

    private static BoundSql bound(String statementId, Object param) {
        MappedStatement ms = configuration.getMappedStatement(statementId);
        return ms.getBoundSql(param);
    }

    private static List<MappedStatement> statements() {
        return configuration.getMappedStatementNames().stream().filter(name -> name.contains("."))
                .map(configuration::getMappedStatement).toList();
    }

    private static List<String> params(String statementId, Object param) {
        return bound(statementId, param).getParameterMappings().stream().map(ParameterMapping::getProperty).toList();
    }

    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new HashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    private static Map<String, String> pair(String region, String district) {
        return Map.of("regionCode", region, "districtCode", district);
    }

    // ---- 계약 ----

    @Test
    void 연결된_Mapper_계약_검사를_통과하고_미이식_모듈에는_statement_가_없다() {
        SqlSessionFactory factory = mock(SqlSessionFactory.class);
        when(factory.getConfiguration()).thenReturn(configuration);
        assertThatCode(() -> new MapperContractVerifier(factory)).doesNotThrowAnyException();
        for (Class<?> pending : MapperContractVerifier.PENDING_MODULES) {
            for (Method method : pending.getDeclaredMethods()) {
                assertThat(configuration.hasStatement(pending.getName() + "." + method.getName(), false))
                        .as("미이식 모듈에 가짜 SQL 금지: " + pending.getSimpleName() + "." + method.getName()).isFalse();
            }
        }
        assertThat(MapperContractVerifier.CONTRACTS.keySet()).containsExactlyInAnyOrder(ProgramMapper.class,
                PackageMapper.class, AccountMapper.class, ReferenceMapper.class, RecordsMapper.class, AnalyticsMapper.class,
                CallingMapper.class, CallingSheetMapper.class, BusinessMapper.class, AnalysisMapper.class,
                LibrarySettingsMapper.class, AfterReportMapper.class);
    }

    @Test
    void 계약_검사는_빠진_statement_를_누락_목록과_함께_실패시킨다() {
        Configuration partial = new Configuration();
        SqlSessionFactory factory = mock(SqlSessionFactory.class);
        when(factory.getConfiguration()).thenReturn(partial);
        assertThatThrownBy(() -> new MapperContractVerifier(factory)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("selectAccountById").hasMessageContaining("selectPeople")
                .hasMessageContaining("자동 전환하지 않습니다");
    }

    @Test
    void 모든_statement_는_가짜_SELECT_1_이나_TODO_가_아니다() {
        Set<Class<?>> checkedWithGenericParameters = Set.of(ProgramMapper.class, PackageMapper.class,
                AccountMapper.class, ReferenceMapper.class, RecordsMapper.class);
        for (MappedStatement ms : statements()) {
            if (checkedWithGenericParameters.stream().noneMatch(c -> ms.getId().startsWith(c.getName() + "."))) {
                continue;
            }
            Map<String, Object> dynamic = map("changed", Set.of(), "scopeAll", true, "districts", List.of(), "f", baseFilter(),
                    "phoneChange", false, "personId", null);
            String text = ms.getBoundSql(dynamic).getSql().replaceAll("\\s+", " ");
            assertThat(text).as(ms.getId()).doesNotContain("SELECT 1").doesNotContain("TODO");
        }
    }

    // ---- resultMap ↔ SELECT 별칭 ----

    @Test
    void resultMap_컬럼은_해당_SELECT_의_별칭과_모두_일치한다() {
        Map<String, Object> dummy = map("id", "1", "usernameKey", "u", "packageId", "p", "programId", "g", "pagePath", "/x",
                "nameKey", "n");
        for (MappedStatement ms : statements()) {
            if (ms.getId().startsWith(AnalysisMapper.class.getName() + ".")) continue;
            if (ms.getResultMaps().isEmpty() || ms.getResultMaps().get(0).getResultMappings().isEmpty()) {
                continue;
            }
            ResultMap resultMap = ms.getResultMaps().get(0);
            String text = ms.getBoundSql(dummy).getSql().replaceAll("\\s+", " ");
            for (ResultMapping mapping : resultMap.getResultMappings()) {
                assertThat(text).as(ms.getId() + " → " + mapping.getColumn()).contains(" AS " + mapping.getColumn());
            }
        }
    }

    @Test
    void 대상자_SELECT_는_모든_원본_필드를_별칭으로_돌려주고_연락처_암호문은_읽지_않는다() {
        String text = sql("com.smoa.module.mapper.RecordsMapper.selectPeople", listParams(false, List.of(pair("R1", "D1")), baseFilter()));
        for (PersonField field : PersonField.values()) {
            assertThat(text).as(field.key()).contains(" AS " + field.key());
        }
        assertThat(text).contains("AS phoneLast4").contains("AS rowVersion").doesNotContain("PHONE_ENC").doesNotContain("SOURCE_ENC");
        String activity = sql("com.smoa.module.mapper.RecordsMapper.selectActivities",
                listParams(false, List.of(pair("R1", "D1")), baseFilter()));
        for (ActivityField field : ActivityField.values()) {
            assertThat(activity).as(field.key()).contains(" AS " + field.key());
        }
        assertThat(activity).contains("AS personId");
    }

    // ---- 구역 범위 / LIB_ID ----

    private static Map<String, Object> baseFilter() {
        return map("includeDeleted", false, "limit", 100, "offset", 0);
    }

    private static Map<String, Object> listParams(boolean scopeAll, List<Map<String, String>> districts, Map<String, Object> f) {
        return map("libId", "LIB-1", "f", f, "scopeAll", scopeAll, "districts", districts);
    }

    @Test
    void ORG_범위는_지역_구역_쌍의_OR_이_하나의_괄호로_묶여_LIB_ID_와_AND_된다() {
        String id = "com.smoa.module.mapper.RecordsMapper.selectPeople";
        Map<String, Object> p = listParams(false, List.of(pair("R1", "D1"), pair("R2", "D1")), baseFilter());
        String text = sql(id, p);
        assertThat(text).contains("T.LIB_ID = ?");
        // 두 쌍의 OR 는 하나의 괄호 덩어리이고 그 바깥을 다시 괄호로 감싸 AND 로 잇는다.
        assertThat(text).containsPattern("AND\\s*\\(\\s*\\(1 = 0\\s+OR\\s+\\(T\\.ORG_MSTR_CODE = \\? AND T\\.ORG_CODE = \\?\\)\\s+OR\\s+"
                + "\\(T\\.ORG_MSTR_CODE = \\? AND T\\.ORG_CODE = \\?\\)\\s*\\)\\s*\\)");
        // 값은 모두 바인딩(리터럴로 SQL 에 들어가지 않는다)
        assertThat(text).doesNotContain("R1").doesNotContain("LIB-1");
        assertThat(params(id, p)).startsWith("libId", "__frch_d_0.regionCode", "__frch_d_0.districtCode",
                "__frch_d_1.regionCode", "__frch_d_1.districtCode");
        // OR 는 같은 조건 안에서만: LIB_ID 조건이 OR 의 한쪽이 되는 모양이 없다
        assertThat(text).doesNotContainPattern("LIB_ID = \\? OR").doesNotContainPattern("OR T\\.LIB_ID");
        // 지역 코드 없이 구역 코드만 비교하는 조건이 없다
        Matcher m = Pattern.compile("T\\.ORG_CODE = \\?").matcher(text);
        while (m.find()) {
            assertThat(text.substring(Math.max(0, m.start() - 40), m.start())).contains("T.ORG_MSTR_CODE = ? AND ");
        }
    }

    @Test
    void ALL_은_구역조건이_없고_빈_ORG_는_0행_조건이다() {
        String id = "com.smoa.module.mapper.RecordsMapper.selectPeople";
        assertThat(sql(id, listParams(true, List.of(), baseFilter()))).contains("1 = 1").doesNotContain("ORG_MSTR_CODE = ?");
        String empty = sql(id, listParams(false, List.of(), baseFilter()));
        assertThat(empty).contains("1 = 0").doesNotContain("ORG_MSTR_CODE = ?");
        assertThat(sql(id, listParams(false, null, baseFilter()))).contains("1 = 0");
    }

    @Test
    void 모든_업무_statement_에_LIB_ID_조건이_있다() {
        String ns = "com.smoa.module.mapper.RecordsMapper.";
        Map<String, Object> p = map("libId", "L", "id", "1", "personId", "1", "f", baseFilter(), "scopeAll", true, "districts", List.of(),
                "changed", Set.of("name"), "expectedVersion", 1L, "limit", 10, "employeeId", "e");
        for (String id : List.of("selectCodeItems", "selectMigrationSourceId", "selectPeople", "selectPersonById",
                "selectActivities", "selectActivityById", "selectHistory", "countHistory", "selectStageTransitions",
                "updatePerson", "updateActivity", "attachInitialPhone", "insertStageLog", "insertStatusLog",
                "lockLibrary", "selectLastChangeLog", "selectLibrary")) {
            assertThat(sql(ns + id, p)).as(id).containsPattern("LIB_ID\\s*=\\s*\\?");
        }
        for (String id : List.of("insertPerson", "insertActivity", "insertChangeLog")) {
            assertThat(sql(ns + id, map("libId", "L"))).as(id).contains("LIB_ID");
            assertThat(params(ns + id, map("libId", "L"))).as(id).startsWith("libId");
        }
    }

    @Test
    void 이력_조회는_범위를_대상자_현재_구역_기준으로_걸고_CHGLOG_는_연결되지_않으면_숨긴다() {
        String ns = "com.smoa.module.mapper.RecordsMapper.";
        Map<String, Object> org = listParams(false, List.of(pair("R1", "D1")), baseFilter());
        String stage = sql(ns + "selectHistory", org);
        assertThat(stage).contains("JOIN TGMSTR T ON T.TGT_ID = L.TGT_ID AND T.LIB_ID = L.LIB_ID").contains("T.ORG_MSTR_CODE = ?");
        String change = sql(ns + "selectHistory", org);
        assertThat(change).contains("T.TGT_ID IS NOT NULL AND").contains("A.ACT_ID IS NOT NULL AND");
        assertThat(sql(ns + "selectHistory", listParams(false, List.of(), baseFilter())))
                .contains("1 = 0");
    }

    // ---- 쓰기 ----

    @Test
    void 부분_수정은_지정한_필드만_SET_하고_버전_범위_LIB_ID_조건을_가진다() {
        String id = "com.smoa.module.mapper.RecordsMapper.updatePerson";
        Map<String, Object> p = map("libId", "L", "id", "5", "expectedVersion", 3L, "changed", new TreeSet<>(Set.of("name", "notes")),
                "name", "새이름", "notes", null, "phoneChange", false, "scopeAll", false, "districts", List.of(pair("R1", "D1")),
                "sysUserId", "u", "sysIp", "ip", "sysAt", java.time.LocalDateTime.now());
        String text = sql(id, p);
        assertThat(text).contains("T.TGT_NAME_HAN = ?").contains("T.NOTES = ?");
        for (String untouched : new String[] {"SEX_CODE", "AGE", "STAGE_CODE", "STATUS_CODE", "PHONE_ENC", "PHONE_LAST4",
                "SOURCE_ENC", "LEGACY_ID", "TGT_CODE", "CUSTOM_JSON", "DEL_IND", "FOUND_DATE"}) {
            assertThat(text).as(untouched).doesNotContain(untouched + " =");
        }
        assertThat(text).contains("T.ROW_VERSION = T.ROW_VERSION + 1").contains("T.ROW_VERSION = ?").contains("T.LIB_ID = ?")
                .contains("T.TGT_ID = ?");
        assertThat(text).containsPattern("AND\\s*\\(\\s*\\(1 = 0\\s+OR\\s+\\(T\\.ORG_MSTR_CODE = \\? AND T\\.ORG_CODE = \\?\\)\\s*\\)\\s*\\)");
        assertThat(params(id, p)).contains("name", "notes", "expectedVersion", "libId", "id");
        // 연락처는 phoneChange 일 때만 SET 에 들어간다
        p.put("phoneChange", true);
        p.put("phoneEnc", "x");
        assertThat(sql(id, p)).contains("T.PHONE_ENC = ?").contains("T.PHONE_LAST4 = ?");
    }

    @Test
    void 삭제는_상태코드가_아니라_DEL_IND_로_표현한다() {
        String text = sql("com.smoa.module.mapper.RecordsMapper.updatePerson", map("libId", "L", "id", "1", "expectedVersion", 1L,
                "changed", Set.of("deleted"), "deleted", true, "scopeAll", true, "districts", List.of()));
        assertThat(text).contains("T.DEL_IND = IF(?, 'Y', 'N')").doesNotContain("STATUS_CODE =");
        assertThat(sql("com.smoa.module.mapper.RecordsMapper.selectPeople", listParams(true, List.of(), baseFilter()))).contains("T.DEL_IND = 'N'");
        assertThat(sql("com.smoa.module.mapper.RecordsMapper.selectActivities", listParams(true, List.of(), baseFilter()))).contains("A.DEL_IND = 'N'");
    }

    @Test
    void 대상자_INSERT_는_모든_원본_필드를_바인딩하고_UUID_나_연락처를_넣지_않는다() {
        String id = "com.smoa.module.mapper.RecordsMapper.insertPerson";
        List<String> props = params(id, map());
        for (PersonField field : PersonField.values()) {
            if (field == PersonField.DELETED) {   // 새 행은 항상 DEL_IND='N' 리터럴
                continue;
            }
            assertThat(props).as(field.key()).contains(field.key());
        }
        String text = sql(id, map());
        assertThat(text).doesNotContain("PHONE_ENC").doesNotContain("SOURCE_ENC").doesNotContain("TGT_ID,").contains("ROW_VERSION");
        assertThat(configuration.getMappedStatement("com.smoa.module.mapper.RecordsMapper.insertPerson").getKeyProperties()).containsExactly("id");
        assertThat(configuration.getMappedStatement("com.smoa.module.mapper.RecordsMapper.insertPerson").getKeyColumns()).containsExactly("TGT_ID");
    }

    @Test
    void 모든_쓰기와_조회_값은_바인딩이고_문자열_결합_치환자_는_범위_별칭_하나뿐이다() throws Exception {
        for (String xml : XML) {
            try (InputStream in = getClass().getClassLoader().getResourceAsStream(xml)) {
                String content = new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                Matcher m = Pattern.compile("\\$\\{([^}]*)}").matcher(content);
                List<String> found = new ArrayList<>();
                while (m.find()) {
                    found.add(m.group(1));
                }
                assertThat(found).as(xml).allMatch("a"::equals);
            }
        }
    }

    // ---- identity ----

    @Test
    void 계정_SQL_은_대소문자_무시_로그인_조회와_행잠금_카운트를_가진다() {
        String ns = "com.smoa.account.persistence.AccountMapper.";
        assertThat(sql(ns + "selectAccountByUsernameKey", map("usernameKey", "admin")))
                .contains("U.LOGIN_ID = ? COLLATE utf8mb4_general_ci");
        String count = sql(ns + "countActiveSuperAdmins", map());
        assertThat(count).contains("FOR UPDATE").contains("A.SUPER_ADMIN_IND = 'Y'").contains("U.USE_IND = 'Y'").contains("A.USE_IND = 'Y'");
        assertThat(sql(ns + "lockSuperAdminPackages", map())).contains("FOR UPDATE").contains("SUPER_ADMIN_IND = 'Y'");
        String insert = sql(ns + "insertAccount", map());
        assertThat(insert).contains("IF(?, 'Y', 'N')").contains("SYS_RUSR_ID").contains("SYS_MUSR_DTTM");
        String update = sql(ns + "updateAccount", map());
        assertThat(update).doesNotContain("LOGIN_ID =").doesNotContain("EMPL_ID").doesNotContain("SYS_RUSR");
    }

    @Test
    void 패키지_SQL_은_구역_복합키를_저장하고_보호속성은_UPDATE_로_바꾸지_않는다() {
        String ns = "com.smoa.permission.persistence.PackageMapper.";
        assertThat(sql(ns + "insertDistrict", map())).contains("ORG_MSTR_CODE, ORG_CODE");
        assertThat(sql(ns + "updatePackage", map())).doesNotContain("SUPER_ADMIN_IND");
        assertThat(sql(ns + "selectDistrictsByPackageId", map("packageId", "p"))).contains("O.ORG_MSTR_CODE AS regionCode")
                .contains("O.ORG_CODE AS districtCode");
        assertThat(sql(ns + "selectPackageByNameKey", map("nameKey", "n"))).contains("LOWER(TRIM(A.AUTH_NAME_HAN)) = ?");
    }

    @Test
    void 참조_SQL_은_읽기_전용이다() {
        for (MappedStatement ms : statements()) {
            if (ms.getId().startsWith("com.smoa.reference.persistence.ReferenceMapper.")) {
                assertThat(ms.getSqlCommandType().name()).isEqualTo("SELECT");
            }
        }
    }
}
