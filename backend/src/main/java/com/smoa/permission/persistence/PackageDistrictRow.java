package com.smoa.permission.persistence;

import java.time.LocalDateTime;

/** 패키지에 배정된 구역. (regionCode, districtCode) 복합키. */
public class PackageDistrictRow {
    public String packageId;
    public String regionCode;
    public String districtCode;
    public String sysUserId;
    public String sysIp;
    public LocalDateTime sysAt;
}
