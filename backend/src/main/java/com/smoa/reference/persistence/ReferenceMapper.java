package com.smoa.reference.persistence;

import java.util.List;

import org.apache.ibatis.annotations.Mapper;

/**
 * 지역·구역 기준 정보 Mapper(읽기 전용). ORGMSTR(지역, PK ORG_MSTR_CODE)과 ORGDTL(구역, PK(ORG_MSTR_CODE, ORG_CODE))을
 * SELECT 로만 읽는다. 이 테이블들은 변경하지 않는다. 구역은 지역코드+구역코드 복합키로만 식별한다.
 */
@Mapper
public interface ReferenceMapper {

    List<RegionRow> selectRegions();

    List<DistrictRow> selectDistricts();

    /** 지역·구역이 모두 활성인 구역(범위 판정용 단일 조회). */
    List<DistrictRow> selectActiveDistricts();
}
