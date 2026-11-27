package com.smoa.calling;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.smoa.access.AccessGrant;
import com.smoa.account.Account;
import com.smoa.account.memory.MemoryUnitOfWork;
import com.smoa.calling.CallingRecord.Outcome;
import com.smoa.calling.CallingRecord.Subject;
import com.smoa.calling.CallingStatistics.Group;
import com.smoa.common.ApiException;
import com.smoa.permission.ActionPermission;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.records.Person;
import com.smoa.records.PersonField;
import com.smoa.records.RecordRepository;
import com.smoa.reference.District;
import com.smoa.reference.ReferenceRepository;
import com.smoa.scope.ScopeEnforcer;

import org.apache.ibatis.builder.xml.XMLMapperBuilder;
import org.apache.ibatis.session.Configuration;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

class CallingParityTest {
    private static final DistrictKey FIRST = new DistrictKey("SYN-R1", "D1");
    private static final DistrictKey OTHER = new DistrictKey("SYN-R2", "D1");
    private final ObjectMapper json = new ObjectMapper();
    private final MemoryCallingRepository calling = new MemoryCallingRepository();
    private final RecordRepository records = mock(RecordRepository.class);
    private final ReferenceRepository reference = mock(ReferenceRepository.class);
    private final CallingService service = new CallingService(calling, records, reference, new ScopeEnforcer(reference), new MemoryUnitOfWork());
    private final CallingImportService importer = new CallingImportService(service, calling, records, reference, new ScopeEnforcer(reference));

    CallingParityTest() {
        when(reference.activeDistricts()).thenReturn(Set.of(FIRST, OTHER));
        when(reference.districts()).thenReturn(List.of(new District(FIRST, "1구역", true), new District(OTHER, "2구역", true)));
    }

    @Test
    void statisticsAgreeWithAllDesktop441FixtureCases() throws Exception {
        var path = Path.of("../docs/parity-fixtures/calling-query-v1.json");
        if (!Files.exists(path)) path = Path.of("docs/parity-fixtures/calling-query-v1.json");
        var fixture = json.readTree(Files.readString(path));
        assertThat(fixture.path("synthetic").asBoolean()).isTrue();
        for (JsonNode row : fixture.path("input").path("records")) {
            String personId = nullable(row, "personId");
            var subject = new Subject(personId, nullable(row, "personName"), nullable(row, "personCode"),
                    nullable(row, "introducer"), "1구역".equals(nullable(row, "area")) ? FIRST : OTHER,
                    null, CallingRules.date(nullable(row, "findingDate"), false), false);
            calling.insert(new CallingRecord(null, 0, subject, LocalDate.parse(row.path("date").asText()),
                    CallingRules.time(nullable(row, "time")), nullable(row, "caller"),
                    CallingRules.parseRound(row.path("roundName").asText(row.path("round").asText()), false), new Outcome(nullable(row, "result"),
                            nullable(row, "originalResult"), nullable(row, "reportedResult")), nullable(row, "notes")));
        }
        for (JsonNode entry : fixture.path("cases")) {
            var params = new LinkedHashMap<String, String>();
            entry.path("query").properties().forEach(e -> params.put(e.getKey(), e.getValue().asText()));
            var expected = entry.path("expected");
            var summary = service.summary(grant(DataScope.all(), true), CallingService.STATS, params, false);
            assertThat(summary.totals().count()).as(params.toString()).isEqualTo(expected.path("totals").path("count").asInt());
            assertThat(summary.totals().successes()).isEqualTo(expected.path("totals").path("successes").asInt());
            assertThat(summary.totals().targets()).isEqualTo(expected.path("totals").path("targets").asInt());
            assertThat(summary.totals().callerCount()).isEqualTo(expected.path("totals").path("callerCount").asInt());
            assertNumber(summary.totals().rate(), expected.path("totals").path("rate"));
            assertThat(summary.missingTime()).isEqualTo(expected.path("missingTime").asInt());
            assertGroups(summary.byHour(), expected.path("byHour"));
            assertGroups(summary.byCaller(), expected.path("byCaller"));
            assertGroups(summary.byRound(), expected.path("byRound"));
            assertGroups(summary.byCallerHour(), expected.path("byCallerHour"));
            assertGroups(summary.byCallerRound(), expected.path("byCallerRound"));
            assertThat(summary.lag().count()).isEqualTo(expected.path("lag").path("count").asInt());
            assertThat(summary.lag().missing()).isEqualTo(expected.path("lag").path("missing").asInt());
            assertNumber(summary.lag().average(), expected.path("lag").path("average"));
            assertNumber(summary.lag().median(), expected.path("lag").path("median"));
            assertNumber(summary.lag().p80(), expected.path("lag").path("p80"));
            var expectedWithin = expected.path("lag").path("within");
            assertThat(summary.lag().within()).hasSize(expectedWithin.size());
            for (int i = 0; i < expectedWithin.size(); i++) {
                var day = summary.lag().within().get(i);
                assertThat(day.days()).isEqualTo(expectedWithin.path(i).path("days").asInt());
                assertThat(day.count()).isEqualTo(expectedWithin.path(i).path("count").asLong());
                assertNumber(day.rate(), expectedWithin.path(i).path("rate"));
            }
            assertThat(summary.report()).isEqualTo(expected.path("reportText").asText());
            assertThat(summary.connected()).isEmpty();
        }
    }

    @Test
    void scopedEditsUseVersionsAndResponsesMaskContactText() {
        var first = grant(DataScope.org(Set.of(FIRST)), true);
        var second = grant(DataScope.org(Set.of(OTHER)), true);
        var readOnly = grant(first.scope(), false);
        var activeFirst = DataScope.org(Set.of(FIRST));
        var person = new Person("10", null, Map.of(PersonField.NAME, "가상동명이인", PersonField.CODE, "SYN-1",
                PersonField.REGION_CODE, FIRST.regionCode(), PersonField.DISTRICT_CODE, FIRST.districtCode(),
                PersonField.FOUND_DATE, "2026-01-01"), "0000", true, 0, "", "");
        when(records.findPerson("10", activeFirst)).thenReturn(Optional.of(person));
        var added = service.save(first, null, input("10", null, "가상콜러", "00:00"));
        assertThat(added.time()).isEqualTo("00:00");
        assertThat(added.notes()).isEqualTo("합성\n***-****-0000");
        assertThat(added.round()).isEqualTo("5차");
        assertThat(service.page(second, Map.of()).total()).isZero();
        assertThat(service.page(first, Map.of("search", "010-0000-0000")).total()).isZero();
        assertThat(service.options(first, CallingService.MANAGE).rounds()).anyMatch(r -> r.value().equals("5차"));
        assertThatThrownBy(() -> service.find(second, added.id())).isInstanceOfSatisfying(ApiException.class,
                error -> assertThat(error.status()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThatThrownBy(() -> service.delete(readOnly, added.id(), Long.valueOf(added.rowVersion())))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.status()).isEqualTo(HttpStatus.FORBIDDEN));
        var changed = service.save(first, added.id(), input(null, Long.valueOf(added.rowVersion()), "가상콜러수정", ""));
        assertThat(changed.time()).isEmpty();
        assertThat(changed.rowVersion()).isNotEqualTo(added.rowVersion());
        assertThatThrownBy(() -> service.save(first, added.id(), input(null, Long.valueOf(added.rowVersion()), "오래된 변경", "")))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.status()).isEqualTo(HttpStatus.CONFLICT));
        service.delete(first, added.id(), Long.valueOf(changed.rowVersion()));
        assertThat(service.page(first, Map.of()).total()).isZero();
    }

    @Test
    void mapperScopesBothTheSnapshotAndTheCurrentProfileWithCompositeKeys() throws Exception {
        String resource = "mapper/module/CallingMapper.xml";
        var config = new Configuration();
        try (var stream = getClass().getClassLoader().getResourceAsStream(resource)) {
            new XMLMapperBuilder(stream, config, resource, config.getSqlFragments()).parse();
        }
        var sql = config.getMappedStatement("com.smoa.module.mapper.CallingMapper.selectCallingRecords")
                .getBoundSql(Map.of("libId", "SYN", "all", false, "unassigned", false, "districts",
                        List.of(Map.of("regionCode", FIRST.regionCode(), "districtCode", FIRST.districtCode())), "limit", 30));
        assertThat(sql.getSql().replaceAll("\\s+", " ")).contains("t.ORG_MSTR_CODE = ? AND t.ORG_CODE = ?",
                "c.ORG_MSTR_CODE = ? AND c.ORG_CODE = ?", "c.LIB_ID = ?", "WHERE h.LIB_ID = c.LIB_ID");
        var unassigned = config.getMappedStatement("com.smoa.module.mapper.CallingMapper.selectCallingRecord")
                .getBoundSql(Map.of("libId", "SYN", "id", "2", "all", false, "unassigned", false, "districts", List.of()));
        assertThat(unassigned.getSql().replaceAll("\\s+", " ")).contains("WHERE c.LIB_ID = ? AND ( (1 = 0 ) ) AND c.CALL_ID = CAST(? AS UNSIGNED)");
    }

    @Test
    void legacyAndMigrationExcelPreviewIsScopedSessionBoundAndIdempotent() throws Exception {
        var scope = DataScope.org(Set.of(FIRST));
        var account = grant(scope, true);
        when(records.searchPeople(new RecordRepository.PeopleQuery(null, null, null, null, null, false,
                null, null, null, 10_001, 0), scope)).thenReturn(List.of(syntheticPerson("24", "가상대상자")));
        String[] connected = {"가상인도자", "1구역", "가상대상자", "가상콜러", "2026.01.03", "0000", "5차", "재콜링", "줄1\n줄2"};
        String[] unlinked = {"", "1구역", "가상미연결", "가상콜러", "2026-01-04", "", "추가", "과거결과", "검사 010-0000-0000"};
        var bytes = fixtureWorkbook(connected, connected, unlinked);
        var normal = importer.excel(account, "session-first", bytes, false);
        assertThat(normal.canApply()).isFalse();
        assertThat(normal.errorCount()).isEqualTo(1);
        assertThat(service.page(account, Map.of()).total()).isZero();
        var preview = importer.excel(account, "session-first", bytes, true);
        assertThat(preview.canApply()).isTrue();
        assertThat(preview.duplicateCount()).isEqualTo(1);
        assertThat(preview.unlinkedCount()).isEqualTo(1);
        assertThat(preview.rows()).anySatisfy(r -> {
            assertThat(r.personId()).isEqualTo("24");
            assertThat(r.round()).isEqualTo("5");
            assertThat(r.time()).isEqualTo("00:00");
            assertThat(r.originalResult()).isEqualTo("재콜링");
            assertThat(r.result()).isEqualTo("재통화");
        });
        assertThatThrownBy(() -> importer.apply(account, "another-session", preview.token()))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.status()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThat(importer.apply(account, "session-first", preview.token()).added()).isEqualTo(2);
        assertThatThrownBy(() -> importer.apply(account, "session-first", preview.token())).isInstanceOf(ApiException.class);
        var repeated = importer.excel(account, "session-first", bytes, true);
        assertThat(repeated.duplicateCount()).isEqualTo(3);
        assertThat(repeated.canApply()).isFalse();
        assertThat(service.exportRows(account, Map.of())).hasSize(2).anySatisfy(r -> {
            assertThat(r.personUnlinked()).isTrue();
            assertThat(r.time()).isEmpty();
            assertThat(r.notes()).isEqualTo("검사 ***-****-0000");
        });
    }

    @Test
    void reportWithUnmatchedTargetCanBeConvertedButCannotBeApplied() throws Exception {
        var account = grant(DataScope.org(Set.of(FIRST)), true);
        String source = """
                ☎ 콜링 배분
                날짜: 01/03(토)
                콜링자/건수
                가상콜러/2건
                ✔️ 5차콜링
                - 1구역
                인도자/대상자/시간대/결과/특이사항
                가상인도자 / 가상미연결 / 17시 / 재콜요청 / A / B
                """;
        var input = new CallingImportService.ReportBody(source, null, "2026", null);
        var preview = importer.report(account, "session", input);
        assertThat(preview.canApply()).isFalse();
        assertThat(preview.canExport()).isTrue();
        assertThat(preview.warnings()).hasSize(1);
        assertThatThrownBy(() -> importer.apply(account, "session", preview.token())).isInstanceOf(ApiException.class);
        var candidate = importer.convert(account, "session", preview.token());
        assertThat(candidate).hasSize(1).first().satisfies(r -> {
            assertThat(r.roundLabel()).isEqualTo("5차");
            assertThat(r.notes()).isEqualTo("A / B");
            assertThat(r.result()).isEqualTo("재통화");
            assertThat(r.resultText()).isEqualTo("재콜요청");
        });
        byte[] out = new CallingXlsx().reportRows(candidate);
        var parsed = CallingImportParser.workbook(out, false);
        assertThat(parsed.report()).isTrue();
        assertThat(parsed.legacyFifth()).isFalse();
        assertThat(parsed.rows()).hasSize(1).first().satisfies(r -> {
            assertThat(r.time()).isEqualTo(java.time.LocalTime.of(17, 0));
            assertThat(r.notes()).isEqualTo("A / B");
        });
        try (var book = new XSSFWorkbook(new ByteArrayInputStream(new CallingXlsx().template()))) {
            assertThat(book.getSheetAt(0).getRow(0).getPhysicalNumberOfCells()).isEqualTo(9);
            assertThat(book.getSheetAt(0).getDataValidations()).hasSize(2);
        }
        assertThat(service.page(account, Map.of()).total()).isZero();
    }

    @Test
    void applyRejectsANewTargetMatchSincePreviewWithoutWritingAnyRecord() throws Exception {
        var scope = DataScope.org(Set.of(FIRST));
        var account = grant(scope, true);
        var search = new RecordRepository.PeopleQuery(null, null, null, null, null, false,
                null, null, null, 10_001, 0);
        when(records.searchPeople(search, scope)).thenReturn(List.of(syntheticPerson("19", "가상대상자")))
                .thenReturn(List.of(syntheticPerson("20", "가상대상자")));
        var workbook = fixtureWorkbook(new String[] {"가상인도자", "1구역", "가상대상자", "가상콜러", "2026-01-03", "", "1차", "만픽", ""});
        var preview = importer.excel(account, "session", workbook, false);
        assertThat(preview.canApply()).isTrue();
        assertThatThrownBy(() -> importer.apply(account, "session", preview.token()))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.status()).isEqualTo(HttpStatus.CONFLICT));
        assertThat(service.page(account, Map.of()).total()).isZero();
    }

    private static Person syntheticPerson(String id, String name) {
        return new Person(id, null, Map.of(PersonField.NAME, name, PersonField.INTRODUCER_NAME, "가상인도자",
                PersonField.REGION_CODE, FIRST.regionCode(), PersonField.DISTRICT_CODE, FIRST.districtCode(),
                PersonField.FOUND_DATE, "2026-01-01"), null, false, 0, "", "");
    }

    private static byte[] fixtureWorkbook(String[]... rows) throws Exception {
        try (var workbook = new XSSFWorkbook(); var output = new ByteArrayOutputStream()) {
            var sheet = workbook.createSheet("콜링");
            var headers = sheet.createRow(0);
            for (int i = 0; i < 9; i++) headers.createCell(i).setCellValue(CallingXlsx.HEADERS.get(i));
            for (int i = 0; i < rows.length; i++) {
                var row = sheet.createRow(i + 1);
                for (int j = 0; j < rows[i].length; j++) row.createCell(j).setCellValue(rows[i][j]);
            }
            workbook.write(output);
            return output.toByteArray();
        }
    }

    private static CallingService.Input input(String personId, Long version, String caller, String time) {
        return new CallingService.Input(personId, "2026-01-04", time, caller, "5차", "만픽", "합성\n010-0000-0000", version);
    }

    private static AccessGrant grant(DataScope scope, boolean write) {
        var account = new Account("SYN", "synthetic", "검사", "SYN", "x", true, 0);
        return new AccessGrant(account, "SYN", "검사", true, false,
                Map.of(CallingService.MANAGE, new ActionPermission(true, true, write, true),
                        CallingService.STATS, new ActionPermission(true, true, false, true)), Map.of(), scope);
    }

    private static void assertGroups(List<Group> rows, JsonNode expected) {
        assertThat(rows).hasSize(expected.size());
        for (int i = 0; i < rows.size(); i++) {
            var group = rows.get(i);
            var want = expected.path(i);
            assertThat(group.caller()).isEqualTo(nullable(want, "caller"));
            assertThat(group.hour()).isEqualTo(want.has("hour") ? want.path("hour").asInt() : null);
            assertThat(group.round()).isEqualTo(nullable(want, "round"));
            assertThat(group.count()).isEqualTo(want.path("count").asInt());
            assertThat(group.successes()).isEqualTo(want.path("successes").asInt());
            assertNumber(group.rate(), want.path("rate"));
        }
    }

    private static void assertNumber(Number actual, JsonNode expected) {
        if (expected.isNull()) assertThat(actual).isNull();
        else assertThat(actual.doubleValue()).isCloseTo(expected.asDouble(), org.assertj.core.api.Assertions.within(0.000001));
    }

    private static String nullable(JsonNode row, String name) {
        return row.path(name).asText(null);
    }
}
