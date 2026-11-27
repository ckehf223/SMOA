package com.smoa.common;

import java.util.List;

/** 모든 오류 응답의 JSON 형태. 내부 예외·SQL·입력 원문은 담지 않는다. */
public record ApiError(String code, String message, List<FieldIssue> fields) {

    public record FieldIssue(String field, String message) {
    }

    public static ApiError of(String code, String message) {
        return new ApiError(code, message, null);
    }
}
