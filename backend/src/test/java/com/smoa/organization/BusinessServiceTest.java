package com.smoa.organization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import com.smoa.access.AccessGrant;
import com.smoa.account.Account;
import com.smoa.common.ApiException;
import com.smoa.config.LibraryContext;
import com.smoa.organization.BusinessService.Filters;
import com.smoa.organization.persistence.BusinessMapper;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.reference.ReferenceRepository;
import com.smoa.scope.ScopeEnforcer;

class BusinessServiceTest {
    private static final DistrictKey DISTRICT = new DistrictKey("R1", "D1");
    private final BusinessMapper mapper = mock(BusinessMapper.class);
    private final ReferenceRepository reference = mock(ReferenceRepository.class);
    private final LibraryContext library = mock(LibraryContext.class);
    private final BusinessService service = new BusinessService(mapper, library, new ScopeEnforcer(reference), reference);

    @Test
    void 기간_조회는_구역을_복합키로_제한하고_부분_월의_월별_기록을_제외한다() {
        when(library.id()).thenReturn("test-library");
        when(reference.activeDistricts()).thenReturn(Set.of(DISTRICT, new DistrictKey("R2", "D1")));
        when(mapper.selectOrganizationMembers(anyMap())).thenReturn(List.of(
                Map.of("id", "m1", "name", "첫번째", "useInd", "Y"),
                Map.of("id", "m2", "name", "두번째", "useInd", "Y")));
        when(mapper.selectRegionalRecords(anyMap())).thenReturn(List.of(
                Map.of("memberId", "m1", "id", "8", "date", "2026-11-14", "status", 3),
                Map.of("memberId", "m1", "id", "7", "date", "2026-11-13", "status", 1),
                Map.of("memberId", "retired", "id", "6", "date", "2026-11-13", "status", 2)));
        var response = service.regionalActivity(grant(), filters("R1", "D1", "2026-10-15", "2026-11-15", "range"));
        assertThat(rows(response)).hasSize(2);
        assertThat(rows(response).getFirst()).containsEntry("id", "7").containsEntry("statusName", "적극적 활동자");
        assertThat(rows(response).getLast()).containsEntry("memberId", "m2").containsEntry("statusName", "미기록");
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> arguments = ArgumentCaptor.forClass(Map.class);
        verify(mapper).selectRegionalRecords(arguments.capture());
        assertThat(arguments.getValue()).containsEntry("libraryId", "test-library").containsEntry("districts", Set.of(DISTRICT))
                .containsEntry("fromMonth", "2026-11").containsEntry("toMonth", "2026-10");
        assertThatThrownBy(() -> service.regionalActivity(grant(), filters("R2", "D1", null, null, "all")))
                .isInstanceOf(ApiException.class).extracting("code").isEqualTo("OUT_OF_SCOPE");
    }

    @Test
    void 실적_집계는_확인된_첫_진입만_계산하고_다른_구역_이력을_제외한다() {
        when(library.id()).thenReturn("test-library");
        when(reference.activeDistricts()).thenReturn(Set.of(DISTRICT, new DistrictKey("R2", "D1")));
        when(mapper.selectGoals(anyMap())).thenReturn(List.of(Map.of(
                "id", "1", "regionCode", "R1", "districtCode", "D1", "from", "2026-11-01", "to", "2026-11-30",
                "stageId", "a", "stageName", "찾A", "target", 2)));
        when(mapper.selectFindingAttainments(anyMap())).thenReturn(List.of(
                Map.of("personId", "p1"), Map.of("personId", "p2"), Map.of("personId", "p3", "firstReportStatus", "유지")));
        when(mapper.selectStageAttainments(anyMap())).thenReturn(List.of(
                Map.of("personId", "p1", "stageId", "a", "date", "2026-11-02", "baseline", "N", "regionCode", "R1", "districtCode", "D1"),
                Map.of("personId", "p1", "stageId", "a", "date", "2026-11-03", "baseline", "N", "regionCode", "R1", "districtCode", "D1"),
                Map.of("personId", "p2", "stageId", "a", "date", "2026-11-03", "baseline", "N", "regionCode", "R2", "districtCode", "D1"),
                Map.of("personId", "p3", "stageId", "a", "date", "2026-11-03", "baseline", "N", "regionCode", "R1",
                        "districtCode", "D1", "reason", "일보 최초 확인")));
        var response = service.goals(grant(), filters(null, null, null, null, null));
        assertThat(rows(response)).hasSize(1);
        assertThat(rows(response).getFirst()).containsEntry("actual", 1).containsEntry("shortfall", 1).containsEntry("rate", 50.0);
    }

    @Test
    void 구역_현황은_같은_활동자의_시간을_합치고_같은_구역_활동과_찾기만_연결한다() {
        when(library.id()).thenReturn("test-library");
        when(reference.activeDistricts()).thenReturn(Set.of(DISTRICT, new DistrictKey("R2", "D1")));
        when(mapper.selectOrganizationMembers(anyMap())).thenReturn(List.of(
                Map.of("id", "known", "regionCode", "R1", "districtCode", "D1", "useInd", "Y", "status", "active")));
        when(mapper.selectDistrictActivities(anyMap())).thenReturn(List.of(
                activity("09:10", "10:15", "노방"), activity("09:55", "10:30", "노방"),
                activity("11:00", "12:00", "소셜링")));
        when(mapper.selectFindingAttainments(anyMap())).thenReturn(List.of(
                finding("R1", "2026-11-13", "09:00"), finding("R1", "2026-11-13", "10:30"),
                finding("R1", "2026-11-12", "12:00"), finding("R2", "2026-11-13", "09:30")));
        var service = new RegionDataService(this.service, mapper, new ScopeEnforcer(reference));
        var result = service.overview(grant(), new RegionDataService.Query("2026-11-13", "2026-11-13", null, null, "노방"));
        assertThat(result.total().minutes()).isEqualTo(80);
        assertThat(result.total().matched()).isEqualTo(1);
        assertThat(result.total().findings()).isEqualTo(2);
        assertThat(result.total().previous()).isEqualTo(1);
        assertThat(result.total().both()).isEqualTo(1);
        assertThat(result.total().combined()).isEqualTo(1);
        assertThat(result.hours().get(9).minutes()).isEqualTo(50);
        assertThat(result.hours().get(10).minutes()).isEqualTo(30);
    }

    private static Map<String, Object> activity(String start, String end, String classification) {
        return Map.of("regionCode", "R1", "districtCode", "D1", "memberId", "known", "date", "2026-11-13",
                "start", start, "endTime", end, "classification2", classification);
    }

    private static Map<String, Object> finding(String region, String date, String time) {
        return Map.of("regionCode", region, "districtCode", "D1", "memberId", "known", "date", date,
                "foundTime", time, "classification2", "노방");
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> rows(Map<String, Object> response) {
        return (List<Map<String, Object>>) response.get("items");
    }

    private static AccessGrant grant() {
        return new AccessGrant(new Account("account", "user", "검증계정", "pkg", "hash", true, 1),
                "pkg", "패키지", true, false, Map.of(), Map.of(), DataScope.org(List.of(DISTRICT)));
    }

    private static Filters filters(String regionCode, String districtCode, String from, String to, String mode) {
        return new Filters(regionCode, districtCode, from, to, null, null, mode, null, null, null, null, null, null, null);
    }
}
