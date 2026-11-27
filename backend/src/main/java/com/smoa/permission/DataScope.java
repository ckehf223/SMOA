package com.smoa.permission;

import java.util.Collection;
import java.util.Objects;
import java.util.Set;

/**
 * 패키지가 허용하는 데이터 범위. 서버가 저장된 패키지 기준으로만 결정한다.
 *
 * <p>{@code listedOnly} 는 "ALL 이지만 목록에 든 구역(활성 구역)과 구역 미지정 행만"이라는 서버 내부 제한이다.
 * 비활성·미등록 구역 자료를 ALL 계정에게도 숨기면서 SQL 의 총건수·페이지가 화면 결과와 어긋나지 않게 하려고 쓴다
 * ({@code ScopeEnforcer#effectiveScope}). 패키지에 저장되는 값이 아니다.
 */
public record DataScope(ScopeType type, Set<DistrictKey> districts, boolean listedOnly) {

    public DataScope {
        Objects.requireNonNull(type, "type");
        districts = (type == ScopeType.ALL && !listedOnly) || districts == null ? Set.of() : Set.copyOf(districts);
        listedOnly = type == ScopeType.ALL && listedOnly;
    }

    public DataScope(ScopeType type, Set<DistrictKey> districts) {
        this(type, districts, false);
    }

    public static DataScope all() {
        return new DataScope(ScopeType.ALL, Set.of(), false);
    }

    /** ALL 이되 지정한(활성) 구역과 구역 미지정 행만. */
    public static DataScope allListed(Collection<DistrictKey> listed) {
        return new DataScope(ScopeType.ALL, listed == null ? Set.of() : Set.copyOf(listed), true);
    }

    public static DataScope org(Collection<DistrictKey> districts) {
        return new DataScope(ScopeType.ORG, districts == null ? Set.of() : Set.copyOf(districts), false);
    }

    public static DataScope none() {
        return org(Set.of());
    }

    public boolean allows(DistrictKey key) {
        if (key == null) {
            return false;
        }
        return type == ScopeType.ALL ? !listedOnly || districts.contains(key) : districts.contains(key);
    }

    /**
     * 업무 자료 행의 구역(없을 수 있음)이 이 범위에 들어오는가. ALL 은 구역 미지정 행도 포함하고(listedOnly 이면 지정 구역은 목록에 있어야 함),
     * ORG 는 구역이 있고 배정 목록에 있을 때만 true(빈 배정·구역 미지정은 false = fail-closed).
     */
    public boolean covers(DistrictKey key) {
        if (type == ScopeType.ALL) {
            return !listedOnly || key == null || districts.contains(key);
        }
        return key != null && districts.contains(key);
    }

    /** 구역이 하나도 배정되지 않은 범위: 0건/거부. */
    public boolean isEmptyAssignment() {
        return type == ScopeType.ORG && districts.isEmpty();
    }

    /** SQL 에서 구역 조건 없이 전체인가(ALL 이고 목록 제한 없음). */
    public boolean unrestricted() {
        return type == ScopeType.ALL && !listedOnly;
    }
}
