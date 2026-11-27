package com.smoa.permission.persistence;

import java.time.LocalDateTime;

public class PackagePermissionRow {
    public String packageId;
    public String programId;
    public Boolean accessAllowed;
    public Boolean readAllowed;
    public Boolean writeAllowed;
    public Boolean exportAllowed;
    public String sysUserId;
    public String sysIp;
    public LocalDateTime sysAt;
}
