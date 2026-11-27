package com.smoa.module.mapper;

import java.util.List;
import java.util.Map;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import com.smoa.analytics.AnalyticsService.Query;
import com.smoa.analytics.PerformanceService.Filter;
import com.smoa.permission.DistrictKey;

@Mapper
public interface AnalyticsMapper {
    List<Map<String, Object>> selectPeopleMetrics(@Param("libId") String libraryId,
            @Param("f") Query query, @Param("districts") List<DistrictKey> districts,
            @Param("unassigned") boolean unassigned);

    List<Map<String, Object>> selectActivityMetrics(@Param("libId") String libraryId,
            @Param("f") Query query, @Param("districts") List<DistrictKey> districts,
            @Param("unassigned") boolean unassigned);

    List<Map<String, Object>> selectPerformancePeople(@Param("libId") String libraryId,
            @Param("f") Filter query, @Param("districts") List<DistrictKey> districts,
            @Param("unassigned") boolean unassigned);

    List<Map<String, Object>> selectPerformanceActivity(@Param("libId") String libraryId,
            @Param("f") Filter query, @Param("districts") List<DistrictKey> districts,
            @Param("unassigned") boolean unassigned);
}
