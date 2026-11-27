package com.smoa.permission;

import com.smoa.program.Program;
import com.smoa.program.ProgramAction;

/** 한 프로그램에 대한 동작 권한. 기본값은 모두 거부. */
public record ActionPermission(boolean access, boolean read, boolean write, boolean export) {

    public static final ActionPermission NONE = new ActionPermission(false, false, false, false);

    public boolean allows(ProgramAction action) {
        return switch (action) {
            case ACCESS -> access;
            case READ -> read;
            case WRITE -> write;
            case EXPORT -> export;
        };
    }

    public boolean isNone() {
        return !access && !read && !write && !export;
    }

    /** access=false 이면 전부 false, read=false 이면 write/export 도 false, 프로그램에 없는 동작도 false. */
    public ActionPermission normalizedFor(Program program) {
        boolean a = access;
        boolean r = a && program.supports(ProgramAction.READ) && read;
        boolean w = r && program.supports(ProgramAction.WRITE) && write;
        boolean e = r && program.supports(ProgramAction.EXPORT) && export;
        return new ActionPermission(a, r, w, e);
    }

    /** 프로그램이 지원하는 모든 동작을 허용(총관리자 시스템 패키지용). */
    public static ActionPermission full(Program program) {
        return new ActionPermission(true, program.supports(ProgramAction.READ), program.supports(ProgramAction.WRITE),
                program.supports(ProgramAction.EXPORT));
    }
}
