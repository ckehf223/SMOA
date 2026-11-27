package com.smoa.program;

import java.util.Locale;

/** 프로그램(최하위 메뉴)에서 허용할 수 있는 동작. ACCESS 는 모든 프로그램에 있다. */
public enum ProgramAction {
    ACCESS, READ, WRITE, EXPORT;

    public String json() {
        return name().toLowerCase(Locale.ROOT);
    }
}
