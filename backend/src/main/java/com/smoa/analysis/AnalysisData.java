package com.smoa.analysis;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;

import com.smoa.permission.DistrictKey;

public final class AnalysisData {
    private AnalysisData() {}

    public record Filter(LocalDate from, LocalDate to, String regionCode, String districtCode, boolean roadOnly) {
        public boolean includes(LocalDate date) {
            return date != null && (from == null || !date.isBefore(from)) && (to == null || !date.isAfter(to));
        }
    }

    public record Finding(LocalDate date, LocalTime time, String regionCode, String districtCode, String place,
            String classification, LocalDate manpikDate, LocalDate findADate) {
        DistrictKey district() {
            return key(regionCode, districtCode);
        }
    }

    public record Activity(LocalDate date, LocalTime start, LocalTime end, String regionCode, String districtCode,
            String workerId, String workerCode, String workerName, String jobCode, String place, String sessionKey,
            String memo) {
        DistrictKey district() {
            return key(regionCode, districtCode);
        }
    }

    public record Rows(List<Finding> findings, List<Activity> activities) {}

    private static DistrictKey key(String region, String district) {
        return DistrictKey.valid(region, district) ? new DistrictKey(region, district) : null;
    }
}
