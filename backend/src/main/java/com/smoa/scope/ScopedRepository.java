package com.smoa.scope;

import java.util.List;
import java.util.Optional;

import com.smoa.permission.DataScope;

/**
 * 구역 범위를 강제하는 저장소 계약. 모든 조회·변경 메서드가 서버가 정한 {@link DataScope} 를 받으며,
 * 구현(SQL)은 범위 조건((지역코드, 구역코드) 쌍 IN 조건, 빈 집합이면 0건)을 WHERE 에 포함해야 한다.
 * {@link ScopeEnforcer} 가 호출 전·후로 다시 검사한다.
 */
public interface ScopedRepository<T extends DistrictScoped, ID> {

    List<T> findAll(DataScope scope);

    Optional<T> findById(ID id, DataScope scope);

    /** 호출자가 entity 의 구역이 범위 안임을 이미 확인한 뒤 호출한다. */
    T insert(T entity);

    /** 범위 안에서 id 가 일치하는 행만 수정한다. 대상이 없으면 empty. */
    Optional<T> update(T entity, DataScope scope);

    /** 범위 안에서 삭제. 지운 행이 있으면 true. */
    boolean deleteById(ID id, DataScope scope);
}
