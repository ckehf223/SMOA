package com.smoa.callingsheet;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.smoa.access.AccessGrant;
import com.smoa.permission.DistrictKey;
import com.smoa.permission.ScopeType;
import com.smoa.reference.ReferenceRepository;

/**
 * 서버가 계산한 "이 요청이 볼 수 있는 행" 조건. 요청 파라미터는 반영하지 않고 {@link AccessGrant} 와 활성 구역 목록으로만 만든다.
 * <ul>
 *   <li>ORG: 배정 구역 ∩ 활성 구역. 구역 미지정 행은 보이지 않는다. 배정이 비면 0행.</li>
 *   <li>ALL: 활성 구역 전부 + 구역 미지정 행. 비활성·미등록 구역의 행은 보이지 않는다(ScopeEnforcer 와 같은 정책).</li>
 * </ul>
 * 이 값을 SQL 의 WHERE(복합키 OR 괄호)와 메모리 구현에 똑같이 적용하므로 목록·총건수·차트·내보내기·단건이 같은 행 집합을 본다.
 */
public record ScopeSpec(boolean unassigned, Set<DistrictKey> districts) {

    public ScopeSpec {
        districts = districts == null ? Set.of() : Set.copyOf(districts);
    }

    public static ScopeSpec of(AccessGrant grant, ReferenceRepository reference) {
        Set<DistrictKey> active = reference.activeDistricts();
        if (grant.scope().type() == ScopeType.ALL) {
            return new ScopeSpec(true, active);
        }
        Set<DistrictKey> assigned = new HashSet<>(grant.scope().districts());
        assigned.retainAll(active);
        return new ScopeSpec(false, assigned);
    }

    /** 보이는 행이 하나도 없는 범위(SQL 은 1 = 0). */
    public boolean isEmpty() {
        return !unassigned && districts.isEmpty();
    }

    /** 이 구역(없을 수 있음)의 행이 보이는가. 한쪽 코드만 있는 행은 구역 미지정으로 본다. */
    public boolean covers(String regionCode, String districtCode) {
        if (regionCode == null || districtCode == null) {
            return unassigned;
        }
        return DistrictKey.valid(regionCode, districtCode) && districts.contains(new DistrictKey(regionCode, districtCode));
    }

    public List<Map<String, String>> districtPairs() {
        return districts.stream().sorted()
                .map(d -> Map.of("regionCode", d.regionCode(), "districtCode", d.districtCode())).toList();
    }
}
