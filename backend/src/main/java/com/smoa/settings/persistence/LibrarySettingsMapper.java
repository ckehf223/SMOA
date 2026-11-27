package com.smoa.settings.persistence;

import java.util.Map;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import com.smoa.audit.AuditStamp;

@Mapper
public interface LibrarySettingsMapper {
    Map<String, Object> selectLibraryWeekSettings(@Param("libId") String libraryId);

    int saveLibraryWeekStart(@Param("libId") String libraryId, @Param("weekStart") String weekStart,
            @Param("stamp") AuditStamp stamp);

    String selectWebMenuGroups(@Param("libId") String libraryId);

    int saveWebMenuGroups(@Param("libId") String libraryId, @Param("groups") String groups,
            @Param("stamp") AuditStamp stamp);
}
