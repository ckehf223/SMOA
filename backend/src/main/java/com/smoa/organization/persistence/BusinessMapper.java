package com.smoa.organization.persistence;

import java.util.List;
import java.util.Map;

import org.apache.ibatis.annotations.Mapper;

/** 조직 명부·기간 목표·활동과 소셜링 업무 조회. */
@Mapper
public interface BusinessMapper {
    List<Map<String, Object>> selectOrganizationMembers(Map<String, Object> query);

    List<Map<String, Object>> selectCodeGroups(Map<String, Object> query);

    List<Map<String, Object>> selectCodes(Map<String, Object> query);

    List<Map<String, Object>> selectGoals(Map<String, Object> query);

    List<Map<String, Object>> selectFindingAttainments(Map<String, Object> query);

    List<Map<String, Object>> selectStageAttainments(Map<String, Object> query);

    List<Map<String, Object>> selectRegionalRecords(Map<String, Object> query);

    List<Map<String, Object>> selectDistrictActivities(Map<String, Object> query);

    List<Map<String, Object>> selectSocialPrograms(Map<String, Object> query);

    List<Map<String, Object>> selectSocialInflows(Map<String, Object> query);

    List<Map<String, Object>> selectSocialStats(Map<String, Object> query);

    int insertMember(Map<String, Object> row);

    int updateMember(Map<String, Object> row);

    int archiveMember(Map<String, Object> row);

    int countDuplicateGoals(Map<String, Object> row);

    int insertGoal(Map<String, Object> row);

    int updateGoal(Map<String, Object> row);

    int deleteGoal(Map<String, Object> row);

    int insertRegionalRecord(Map<String, Object> row);

    int updateRegionalRecord(Map<String, Object> row);

    int deleteRegionalRecord(Map<String, Object> row);
}
