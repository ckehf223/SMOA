package com.smoa.module.mapper;

import java.util.List;
import java.util.Map;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * socialing 모듈: 소셜링 관리(프로그램·접수·전환).
 * SQL 은 사용자 테이블 확정 전이라 없다. mapper/module/SocialingMapper.xml 에 필수 statement 계약 목록만 주석으로 있고 statement 는 비어 있다.
 * 조회 파라미터 districts 는 서버가 정한 범위((regionCode, districtCode) 쌍 목록)이며 WHERE 에 반드시 포함해야 한다.
 * 작성 위치와 필드는 docs/MODULE_INTEGRATION_GUIDE.md 를 따른다.
 */
@Mapper
public interface SocialingMapper {
    List<Map<String, Object>> selectSocialingPrograms(@Param("districts") List<Map<String, String>> districts);

    int insertSocialingProgram(Map<String, Object> row);

    List<Map<String, Object>> selectSocialingIntakes(@Param("programId") String programId);

    int insertSocialingIntake(Map<String, Object> row);

    int deleteSocialingIntake(@Param("id") String id);
}
