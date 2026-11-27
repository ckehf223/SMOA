package com.smoa.program.persistence;

import java.time.LocalDateTime;

/**
 * PGMMSTR 행. 동작 지원(READ/WRITE/EXPORT_USE_IND)은 컬럼별 불리언이며 ACCESS 는 모든 프로그램에 있다.
 * moduleId/category 는 PGMMSTR.MODULE_ID/CATEGORY_CODE(001-web-persistence.sql)이며 NULL 이면 어댑터가 기본 카탈로그로 해석한다.
 */
public class ProgramRow {
    public String programId;
    public String name;
    public String groupName;
    public String category;
    public String pagePath;
    public String moduleId;
    public Boolean readUse;
    public Boolean writeUse;
    public Boolean exportUse;
    public Boolean superAdminOnly;
    public Boolean active;
    public Integer sortOrder;
    public String sysUserId;
    public String sysIp;
    public LocalDateTime sysAt;
}
