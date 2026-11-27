package com.smoa.module.mapper;

import java.util.List;
import java.util.Map;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * imports 모듈: 엑셀 가져오기·일보 변환(미리보기 확정 이력, 재실행 중복 방지 키).
 * SQL 은 사용자 테이블 확정 전이라 없다. mapper/module/ImportsMapper.xml 에 필수 statement 계약 목록만 주석으로 있고 statement 는 비어 있다.
 * 조회 파라미터 districts 는 서버가 정한 범위((regionCode, districtCode) 쌍 목록)이며 WHERE 에 반드시 포함해야 한다.
 * 작성 위치와 필드는 docs/MODULE_INTEGRATION_GUIDE.md 를 따른다.
 */
@Mapper
public interface ImportsMapper {
    int insertImportBatch(Map<String, Object> row);

    List<Map<String, Object>> selectImportBatches(@Param("districts") List<Map<String, String>> districts);

    int existsImportKey(@Param("sourceKey") String sourceKey);
}
