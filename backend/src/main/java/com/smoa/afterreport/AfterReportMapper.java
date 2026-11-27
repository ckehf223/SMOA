package com.smoa.afterreport;

import java.util.List;
import java.util.Map;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.cursor.Cursor;

import com.smoa.afterreport.AfterReportData.Filter;
import com.smoa.afterreport.AfterReportData.ReportKey;

@Mapper
public interface AfterReportMapper {
    List<Map<String, Object>> find(@Param("libraryId") String libraryId, @Param("filter") Filter filter);

    Cursor<Map<String, Object>> scan(@Param("libraryId") String libraryId, @Param("filter") Filter filter);

    long count(@Param("libraryId") String libraryId, @Param("filter") Filter filter);

    int insertParticipant(Map<String, Object> row);

    int upsertOrganizer(Map<String, Object> row);

    Map<String, Object> findOrganizer(@Param("libraryId") String libraryId, @Param("key") ReportKey key);

    Map<String, Object> findParticipant(@Param("libraryId") String libraryId, @Param("id") long id,
            @Param("key") ReportKey key);
}
