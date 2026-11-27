package com.smoa.module.mapper;

import java.util.List;
import java.util.Map;

import org.apache.ibatis.annotations.Mapper;

/** Parameters use server scope, never a scope provided in request JSON. */
@Mapper
public interface CallingMapper {
    String selectCallingWeekStart(String libId);
    List<Map<String, Object>> selectCallingRecords(Map<String, Object> params);
    List<Map<String, Object>> selectCallingOptions(Map<String, Object> params);
    Map<String, Object> selectCallingRecord(Map<String, Object> params);
    int insertCallingRecord(Map<String, Object> params);
    int updateCallingRecord(Map<String, Object> params);
    int deleteCallingRecord(Map<String, Object> params);
}
