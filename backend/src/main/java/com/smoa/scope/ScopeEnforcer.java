package com.smoa.scope;

import java.util.List;
import java.util.function.UnaryOperator;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import com.smoa.access.AccessGrant;
import com.smoa.common.ApiException;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.reference.ReferenceRepository;

/**
 * 구역 범위 강제 컴포넌트(목록·단건·수정·이동·내보내기·집계 공통). 범위는 인증된 요청의 {@link AccessGrant}(서버 저장 패키지)에서만
 * 가져오며 클라이언트 입력(구역·계정·패키지)은 받지 않는다. 지역이 다르면 구역 코드가 같아도 다른 구역이다.
 * 비활성/미등록 지역·구역의 자료는 범위가 ALL 이어도 보이지 않는다.
 * 정책: 범위 밖 단건 조회/수정/삭제는 존재하지 않는 것과 똑같이 404(존재 여부를 알리지 않음),
 * 범위 밖 구역으로의 생성·이동은 403. 구역 집합이 비면 목록 0건·단건 404.
 */
@Component
public class ScopeEnforcer {

    private static final Logger log = LoggerFactory.getLogger(ScopeEnforcer.class);

    private final ReferenceRepository reference;

    public ScopeEnforcer(ReferenceRepository reference) {
        this.reference = reference;
    }

    /**
     * 이 계정이 이 구역 자료를 볼 수 있는가(범위 + 구역 활성).
     * 구역이 없는(null) 자료는 ALL 범위에서만 보인다(ORG 는 항상 거부). 비활성·미등록 구역은 ALL 이어도 거부한다.
     */
    public boolean visible(AccessGrant grant, DistrictKey key) {
        if (key == null) {
            return grant.scope().type() == com.smoa.permission.ScopeType.ALL;
        }
        return grant.scope().covers(key) && reference.isActive(key);
    }

    /** 목록용: 활성 구역 집합을 한 번만 읽고 행마다 판정한다(행마다 조회하지 않는다). */
    public java.util.function.Predicate<DistrictKey> visibility(AccessGrant grant) {
        DataScope scope = grant.scope();
        if (scope.isEmptyAssignment()) {
            return k -> false;
        }
        java.util.Set<DistrictKey> active = reference.activeDistricts();
        return k -> k == null ? scope.type() == com.smoa.permission.ScopeType.ALL : scope.covers(k) && active.contains(k);
    }

    /**
     * SQL·저장소에 넘기는 유효 범위: 패키지 범위와 활성 구역의 교집합. ORG 는 배정∩활성, ALL 은 "활성 구역 + 구역 미지정"이다.
     * 이 범위로 읽으면 {@link #visible} 로 행마다 걸러낸 것과 같은 결과가 SQL 총건수·페이지에도 그대로 반영된다.
     */
    public DataScope effectiveScope(AccessGrant grant) {
        DataScope scope = grant.scope();
        if (scope.isEmptyAssignment()) {
            return scope;
        }
        java.util.Set<DistrictKey> active = reference.activeDistricts();
        if (scope.type() == com.smoa.permission.ScopeType.ALL) {
            return DataScope.allListed(active);
        }
        return DataScope.org(scope.districts().stream().filter(active::contains).toList());
    }

    public <T extends DistrictScoped, ID> List<T> list(ScopedRepository<T, ID> repository, AccessGrant grant) {
        DataScope scope = grant.scope();
        if (scope.isEmptyAssignment()) {
            return List.of();
        }
        List<T> rows = repository.findAll(scope);
        java.util.function.Predicate<DistrictKey> visibility = visibility(grant);
        List<T> visible = rows.stream().filter(r -> visibility.test(r.districtKey())).toList();
        if (visible.size() != rows.size() && rows.stream().anyMatch(r -> !scope.allows(r.districtKey()))) {
            log.error("저장소가 범위 밖 자료를 반환했습니다(차단함): repository={}", repository.getClass().getSimpleName());
        }
        return visible;
    }

    /** 이미 읽은 행 목록을 집계·내보내기 전에 걸러낸다. */
    public <T extends DistrictScoped> List<T> filter(List<T> rows, AccessGrant grant) {
        if (grant.scope().isEmptyAssignment()) {
            return List.of();
        }
        java.util.function.Predicate<DistrictKey> visibility = visibility(grant);
        return rows.stream().filter(r -> visibility.test(r.districtKey())).toList();
    }

    public <T extends DistrictScoped, ID> T get(ScopedRepository<T, ID> repository, ID id, AccessGrant grant) {
        DataScope scope = grant.scope();
        if (scope.isEmptyAssignment()) {
            throw notFound();
        }
        return repository.findById(id, scope).filter(r -> visible(grant, r.districtKey()))
                .orElseThrow(ScopeEnforcer::notFound);
    }

    public <T extends DistrictScoped, ID> T create(ScopedRepository<T, ID> repository, T entity, AccessGrant grant) {
        if (!visible(grant, entity.districtKey())) {
            throw outOfScope();
        }
        return repository.insert(entity);
    }

    /** 현재 값을 범위 안에서 읽고, mutator 로 바꾼 값도 범위 안일 때만 저장한다. */
    public <T extends DistrictScoped, ID> T update(ScopedRepository<T, ID> repository, ID id, AccessGrant grant,
            UnaryOperator<T> mutator) {
        DataScope scope = grant.scope();
        T current = get(repository, id, grant);
        T next = mutator.apply(current);
        if (!visible(grant, next.districtKey())) {
            throw outOfScope();
        }
        return repository.update(next, scope).orElseThrow(ScopeEnforcer::notFound);
    }

    public <T extends DistrictScoped, ID> void delete(ScopedRepository<T, ID> repository, ID id, AccessGrant grant) {
        get(repository, id, grant);
        if (!repository.deleteById(id, grant.scope())) {
            throw notFound();
        }
    }

    private static ApiException notFound() {
        return ApiException.notFound("자료를 찾을 수 없습니다.");
    }

    private static ApiException outOfScope() {
        return ApiException.forbidden("OUT_OF_SCOPE", "접근할 수 없는 구역입니다.");
    }
}
