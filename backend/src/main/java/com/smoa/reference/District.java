package com.smoa.reference;

import com.smoa.permission.DistrictKey;

/** 구역(참고 사용자 테이블 ORGDTL, PK(ORG_MSTR_CODE, ORG_CODE)). 지역+구역 복합키로만 식별한다. */
public record District(DistrictKey key, String name, boolean active) {
}
