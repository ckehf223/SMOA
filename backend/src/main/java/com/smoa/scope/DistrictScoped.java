package com.smoa.scope;

import com.smoa.permission.DistrictKey;

/** 구역 단위로 접근이 제한되는 자료. 구역은 (지역코드+구역코드) 복합키다. */
public interface DistrictScoped {

    DistrictKey districtKey();
}
