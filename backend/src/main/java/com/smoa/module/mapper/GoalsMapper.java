package com.smoa.module.mapper;

import java.util.List;
import java.util.Map;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * goals 모듈: 구역·반 기간 목표.
 * SQL 은 사용자 테이블 확정 전이라 없다. mapper/module/GoalsMapper.xml 에 필수 statement 계약 목록만 주석으로 있고 statement 는 비어 있다.
 * 조회 파라미터 districts 는 서버가 정한 범위((regionCode, districtCode) 쌍 목록)이며 WHERE 에 반드시 포함해야 한다.
 * 작성 위치와 필드는 docs/MODULE_INTEGRATION_GUIDE.md 를 따른다.
 */
@Mapper
public interface GoalsMapper {
    List<Map<String, Object>> selectGoals(@Param("query") Map<String, Object> query,
            @Param("districts") List<Map<String, String>> districts);

    int upsertGoal(Map<String, Object> row);

    int deleteGoal(@Param("id") String id);
}
