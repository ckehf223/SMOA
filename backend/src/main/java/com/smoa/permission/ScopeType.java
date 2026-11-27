package com.smoa.permission;

public enum ScopeType {
    /** 모든 지역·구역. */
    ALL,
    /** 배정된 (지역+구역) 만. 배정이 하나도 없으면 아무것도 보이지 않는다(전체로 해석하지 않는다). */
    ORG
}
