package com.smoa.analysis;

import java.util.List;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import com.smoa.permission.DistrictKey;

@Mapper
public interface AnalysisMapper {
    List<AnalysisData.Finding> selectFindings(@Param("library") String library, @Param("filter") AnalysisData.Filter filter,
            @Param("districts") List<DistrictKey> districts, @Param("unassigned") boolean unassigned);

    List<AnalysisData.Activity> selectActivities(@Param("library") String library, @Param("filter") AnalysisData.Filter filter,
            @Param("districts") List<DistrictKey> districts, @Param("unassigned") boolean unassigned);
}
