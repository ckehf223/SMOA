package com.smoa.afterreport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import org.apache.ibatis.builder.xml.XMLMapperBuilder;
import org.apache.ibatis.session.Configuration;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.smoa.access.AccessGrant;
import com.smoa.account.Account;
import com.smoa.afterreport.AfterReportData.Filter;
import com.smoa.afterreport.AfterReportData.PeriodTotals;
import com.smoa.afterreport.AfterReportData.Report;
import com.smoa.afterreport.AfterReportData.Role;
import com.smoa.afterreport.AfterReportData.Submission;
import com.smoa.afterreport.AfterReportData.TimeRange;
import com.smoa.common.ApiException;
import com.smoa.permission.ActionPermission;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.reference.District;
import com.smoa.reference.ReferenceRepository;
import com.smoa.reference.Region;
import com.smoa.scope.ScopeEnforcer;

class AfterReportTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final DistrictKey FIRST = new DistrictKey("R1", "D1");
    private static final DistrictKey SECOND = new DistrictKey("R2", "D1");
    private static final DistrictKey INACTIVE = new DistrictKey("R1", "D0");
    private static final String ALL = AfterReportService.ALL;
    private static final String ORGANIZER = AfterReportService.ORGANIZER;
    private static final String PARTICIPANT = AfterReportService.PARTICIPANT;
    private static final String ORGANIZER_BODY = """
            {"date":"2026-11-12","slot":"그 외","regionCode":"R1","districtCode":"D1","location":"직접 입력",
             "name":"가상 주관자","timeRanges":[{"start":"09:00","end":"11:00"}],"findings":3,"headcount":5,
             "personalFindings":null,"organizerChecklist":[true,false,true,false],"notes":"가상 특이사항"}
            """;
    private static final String PARTICIPANT_BODY = """
            {"date":"2026-11-12","slot":"4타임","regionCode":"R1","districtCode":"D1","location":"군자",
             "name":"가상 활동자","timeRanges":[{"start":"10:00","end":"10:30"},{"start":"09:00","end":"09:30"}],
             "findings":0,"participantScores":[1,2,3,2],"remarks":"가상 비고"}
            """;

    @Test
    void organizerUpsertRetainsIdAndKeepsOtherDistrictSeparate() throws Exception {
        var service = service();
        AccessGrant first = grant(DataScope.org(Set.of(FIRST)), true);
        AccessGrant second = grant(DataScope.org(Set.of(SECOND)), true);
        Report before = service.save(first, ORGANIZER, parse(ORGANIZER_BODY));
        Report after = service.save(first, ORGANIZER, parse(ORGANIZER_BODY.replace("가상 주관자", "수정 표시")));
        Report other = service.save(second, ORGANIZER, parse(ORGANIZER_BODY.replace("\"R1\"", "\"R2\"")));
        assertThat(before.id()).isEqualTo(after.id()).isNotEqualTo(other.id());
        assertThat(service.page(first, ALL, null, null, null, null, 1, 10).items())
                .singleElement().extracting(Report::name).isEqualTo("수정 표시");
        assertThat(service.page(first, ALL, null, null, "R2", "D1", 1, 10).total()).isZero();
        assertThat(service.options(grant(DataScope.all(), true), ORGANIZER).districts())
                .extracting(option -> new DistrictKey(option.regionCode(), option.districtCode()))
                .containsExactly(FIRST, SECOND);
        assertThat(service.options(first, ORGANIZER).slots()).doesNotContain("4타임");
    }

    @Test
    void participantSubmissionsAreIndividualAndPreserveRangeOrder() throws Exception {
        var service = service();
        AccessGrant grant = grant(DataScope.org(Set.of(FIRST)), true);
        Report before = service.save(grant, PARTICIPANT, parse(PARTICIPANT_BODY));
        Report after = service.save(grant, PARTICIPANT, parse(PARTICIPANT_BODY));
        assertThat(before.id()).isNotEqualTo(after.id());
        assertThat(before.timeRanges()).containsExactly(
                new TimeRange("10:00", "10:30"), new TimeRange("09:00", "09:30"));
        assertThat(service.page(grant, PARTICIPANT, null, null, null, null, 2, 1).items())
                .singleElement().extracting(Report::id).isEqualTo(before.id());
        assertThat(service.page(grant, ORGANIZER, null, null, null, null, 1, 50).total()).isZero();
        assertThat(service.page(grant, ALL, "2026-11-13", null, null, null, 1, 50).total()).isZero();
    }

    @Test
    void rejectsInvalidRangesCountsAndUnauthorizedWrites() throws Exception {
        var service = service();
        AccessGrant ready = grant(DataScope.org(Set.of(FIRST)), true);
        assertCode(() -> service.save(ready, PARTICIPANT, parse(PARTICIPANT_BODY.replace("\"findings\":0", "\"findings\":1.6"))),
                "INVALID_AFTER_REPORT");
        assertCode(() -> service.save(ready, PARTICIPANT, parse(PARTICIPANT_BODY.replace("10:30", "08:00"))),
                "INVALID_AFTER_REPORT");
        assertCode(() -> service.save(ready, ORGANIZER, parse(ORGANIZER_BODY.replace("그 외", "4타임"))),
                "INVALID_AFTER_REPORT");
        assertCode(() -> service.save(ready, PARTICIPANT, parse(PARTICIPANT_BODY.replace("\"R1\"", "\"R2\""))),
                "OUT_OF_SCOPE");
        assertCode(() -> service.save(ready, PARTICIPANT, parse(PARTICIPANT_BODY.replace("\"D1\"", "\"D0\""))),
                "OUT_OF_SCOPE");
        assertCode(() -> service.save(ready, ALL, parse(ORGANIZER_BODY)), "FORBIDDEN");
        assertCode(() -> service.save(grant(DataScope.all(), false), ORGANIZER, parse(ORGANIZER_BODY)), "FORBIDDEN");
    }

    @Test
    void analysisTotalsUseScopedSubmissionsAndKeepFindingsSeparate() throws Exception {
        var service = service();
        AccessGrant first = grant(DataScope.org(Set.of(FIRST)), true);
        AccessGrant second = grant(DataScope.org(Set.of(SECOND)), true);
        service.save(first, ORGANIZER, parse(ORGANIZER_BODY.replace("\"personalFindings\":null", "\"personalFindings\":100")));
        service.save(first, PARTICIPANT, parse(PARTICIPANT_BODY.replace("\"findings\":0", "\"findings\":2")));
        service.save(first, PARTICIPANT, parse(PARTICIPANT_BODY.replace("2026-11-12", "2026-11-28")
                .replace("[1,2,3,2]", "[3,2,2,1]")));
        service.save(first, PARTICIPANT, parse(PARTICIPANT_BODY.replace("2026-11-12", "2026-12-01")
                .replace("[1,2,3,2]", "[2,3,2,3]")));
        service.save(second, PARTICIPANT, parse(PARTICIPANT_BODY.replace("\"R1\"", "\"R2\"")
                .replace("\"findings\":0", "\"findings\":1000")));

        var analysis = service.analysis(first, ALL, null, null, null, null);
        assertThat(analysis.daily()).containsExactly(
                new PeriodTotals("2026-12-01", 0, 1, 0, 0, 0),
                new PeriodTotals("2026-11-28", 0, 1, 0, 0, 0),
                new PeriodTotals("2026-11-12", 1, 1, 5, 3, 2));
        assertThat(analysis.monthly()).containsExactly(
                new PeriodTotals("2026-12", 0, 1, 0, 0, 0), new PeriodTotals("2026-11", 1, 2, 5, 3, 2));
        var checklist = analysis.checklist().getFirst();
        assertThat(checklist.total()).isEqualTo(3);
        assertThat(List.of(checklist.score1(), checklist.score2(), checklist.score3())).containsExactly(1L, 1L, 1L);
        assertThat(checklist.score3Rate()).isEqualTo(33.3);

        var bounded = service.analysis(first, ALL, "2026-11-12", "2026-11-12", "R1", "D1");
        assertThat(bounded.daily()).containsExactly(new PeriodTotals("2026-11-12", 1, 1, 5, 3, 2));
        var outOfScope = service.analysis(first, ALL, null, null, "R2", "D1");
        assertThat(outOfScope.monthly()).isEmpty();
        assertThat(outOfScope.checklist()).hasSize(4).allSatisfy(item -> {
            assertThat(item.total()).isZero();
            assertThat(item.score3Rate()).isNull();
        });
    }

    @Test
    void analysisRequiresWholeReportReadAndValidFilters() {
        var service = service();
        AccessGrant allowed = grant(DataScope.org(Set.of(FIRST)), false);
        var denied = new AccessGrant(allowed.account(), "fixture-package", "가상 패키지", true, false,
                Map.of(PARTICIPANT, new ActionPermission(true, true, false, false)), Map.of(),
                DataScope.org(Set.of(FIRST)));
        assertCode(() -> service.analysis(denied, ALL, null, null, null, null), "FORBIDDEN");
        assertCode(() -> service.analysis(allowed, ALL, "2026-11-13", "2026-11-12", null, null), "INVALID_AFTER_REPORT");
        assertCode(() -> service.analysis(allowed, ALL, null, null, "R1", null), "INVALID_AFTER_REPORT");
    }

    @Test
    void mapperBindsCompositeScopesAndEmptyScopeIsDenied() throws Exception {
        var configuration = new Configuration();
        var path = "/mapper/afterreport/AfterReportMapper.xml";
        try (var input = getClass().getResourceAsStream(path)) {
            assertThat(input).isNotNull();
            new XMLMapperBuilder(input, configuration, path, configuration.getSqlFragments()).parse();
        }
        for (var method : AfterReportMapper.class.getDeclaredMethods()) {
            assertThat(configuration.hasStatement(AfterReportMapper.class.getName() + "." + method.getName())).isTrue();
        }
        var find = configuration.getMappedStatement(AfterReportMapper.class.getName() + ".find");
        var filter = new Filter(LocalDate.parse("2026-11-12"), null, List.of(FIRST, SECOND), Role.ORGANIZER, 2, 50);
        var bound = find.getBoundSql(Map.of("libraryId", "fixture", "filter", filter));
        assertThat(bound.getSql().replaceAll("\\s+", " "))
                .contains("WHERE LIB_ID = ?", "AND (ORG_MSTR_CODE, ORG_CODE) IN", "AND REPORT_ROLE = ?",
                        "LIMIT ? OFFSET ?");
        assertThat(configuration.newMetaObject(filter).getValue("offset")).isEqualTo(50L);
        var empty = find.getBoundSql(Map.of("libraryId", "fixture", "filter",
                new Filter(null, null, List.of(), null, 1, 50)));
        assertThat(empty.getSql()).contains("AND 1 = 0");
        var scan = configuration.getMappedStatement(AfterReportMapper.class.getName() + ".scan");
        assertThat(scan.getBoundSql(Map.of("libraryId", "fixture", "filter", filter)).getSql().replaceAll("\\s+", " "))
                .contains("WHERE LIB_ID = ?", "AND (ORG_MSTR_CODE, ORG_CODE) IN", "AND ACTIVITY_DATE >= ?")
                .doesNotContain("LIMIT");
    }

    private static Submission parse(String input) throws Exception {
        return JSON.readValue(input, Submission.class);
    }

    private static AfterReportService service() {
        ReferenceRepository reference = new ReferenceRepository() {
            @Override
            public List<Region> regions() { return List.of(new Region("R1", "지역1", true), new Region("R2", "지역2", true)); }
            @Override
            public List<District> districts() {
                return List.of(new District(FIRST, "구역1", true), new District(SECOND, "구역1", true),
                        new District(INACTIVE, "미사용", false));
            }
            @Override
            public Optional<District> findDistrict(DistrictKey key) {
                return districts().stream().filter(d -> d.key().equals(key)).findFirst();
            }
            @Override
            public Set<DistrictKey> activeDistricts() { return Set.of(FIRST, SECOND); }
        };
        return new AfterReportService(new MemoryAfterReportRepository(), reference, new ScopeEnforcer(reference));
    }

    private static AccessGrant grant(DataScope scope, boolean write) {
        var account = new Account("fixture-id", "fixture-name", "가상 계정", "fixture-package", "unused", true, 1);
        var permission = new ActionPermission(true, true, write, false);
        return new AccessGrant(account, "fixture-package", "가상 패키지", true, false,
                Map.of(ALL, permission, ORGANIZER, permission, PARTICIPANT, permission), Map.of(), scope);
    }

    private static void assertCode(org.assertj.core.api.ThrowableAssert.ThrowingCallable operation, String code) {
        assertThatThrownBy(operation).isInstanceOfSatisfying(ApiException.class, failure -> assertThat(failure.code()).isEqualTo(code));
    }
}
