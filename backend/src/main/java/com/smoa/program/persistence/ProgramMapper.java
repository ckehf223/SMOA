package com.smoa.program.persistence;

import java.util.List;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/** 프로그램 정보 Mapper(PGMMSTR). SQL 은 mapper/program/ProgramMapper.xml. */
@Mapper
public interface ProgramMapper {

    ProgramRow selectProgramById(@Param("programId") String programId);

    ProgramRow selectProgramByPagePath(@Param("pagePath") String pagePath);

    /** 정렬: sortOrder, programId 오름차순(비활성 포함). */
    List<ProgramRow> selectAllPrograms();

    int insertProgram(ProgramRow row);

    /** programId 기준 전체 교체(이름·그룹·경로·모듈·분류·동작·활성·순서). 영향 행 1이어야 한다. */
    int updateProgram(ProgramRow row);
}
