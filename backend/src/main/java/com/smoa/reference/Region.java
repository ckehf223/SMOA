package com.smoa.reference;

/** 지역(참고 사용자 테이블 ORGMSTR, PK ORG_MSTR_CODE). */
public record Region(String regionCode, String name, boolean active) {
}
