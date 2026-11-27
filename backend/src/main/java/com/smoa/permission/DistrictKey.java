package com.smoa.permission;

import java.util.regex.Pattern;

/**
 * 구역 식별자: 지역 코드 + 구역 코드 복합키. R1/D1 과 R2/D1 은 서로 다른 구역이다.
 * 코드는 DB 의 ORG_MSTR_CODE/ORG_CODE 값이다(이관된 원본 ID 포함). SQL 은 항상 #{} 바인딩이므로 문자 집합은
 * 공백·따옴표·제어문자·경로 구분자를 막는 정도로 제한한다.
 */
public record DistrictKey(String regionCode, String districtCode) implements Comparable<DistrictKey> {

    public static final Pattern CODE = Pattern.compile("[\\p{L}\\p{N}_.:@-]{1,64}");

    public DistrictKey {
        if (regionCode == null || !CODE.matcher(regionCode).matches() || districtCode == null
                || !CODE.matcher(districtCode).matches()) {
            throw new IllegalArgumentException("지역·구역 코드 형식이 올바르지 않습니다.");
        }
    }

    public static boolean valid(String regionCode, String districtCode) {
        return regionCode != null && districtCode != null && CODE.matcher(regionCode).matches()
                && CODE.matcher(districtCode).matches();
    }

    @Override
    public int compareTo(DistrictKey other) {
        int c = regionCode.compareTo(other.regionCode);
        return c != 0 ? c : districtCode.compareTo(other.districtCode);
    }
}
