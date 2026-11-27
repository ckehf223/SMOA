package com.smoa.reference;

import java.util.List;
import java.util.Optional;
import java.util.Set;

import com.smoa.permission.DistrictKey;

/**
 * 지역·구역 기준 정보(읽기 전용). local-memory 는 가상 자료({@code MemoryReferenceRepository}), local/prod 는
 * 사용자 테이블(ORGMSTR/ORGDTL)을 읽는 {@code MyBatisReferenceRepository}. 운영에 가상 자료가 섞이지 않게 프로파일로 분리한다.
 */
public interface ReferenceRepository {

    List<Region> regions();

    /** 지역코드, 구역코드 오름차순. */
    List<District> districts();

    Optional<District> findDistrict(DistrictKey key);

    /** 지역과 구역이 모두 존재하고 활성인 구역 키 집합(한 번의 조회). 목록 걸러내기에서 행마다 조회하지 않게 한다. */
    Set<DistrictKey> activeDistricts();

    /** 지역과 구역이 모두 존재하고 활성일 때만 true. 비활성·미존재 구역의 자료 접근 차단에 쓴다. */
    default boolean isActive(DistrictKey key) {
        return key != null && activeDistricts().contains(key);
    }
}
