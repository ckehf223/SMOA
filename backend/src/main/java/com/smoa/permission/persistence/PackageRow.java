package com.smoa.permission.persistence;

import java.time.LocalDateTime;

public class PackageRow {
    public String packageId;
    public String name;
    public String nameKey;
    public Boolean active;
    public Boolean superAdmin;
    public String scopeType;
    public String sysUserId;
    public String sysIp;
    public LocalDateTime sysAt;
}
