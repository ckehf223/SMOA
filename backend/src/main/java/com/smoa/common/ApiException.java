package com.smoa.common;

import org.springframework.http.HttpStatus;

/** 클라이언트에 그대로 보여도 되는 메시지만 담는 업무 예외. */
public class ApiException extends RuntimeException {

    private final HttpStatus status;
    private final String code;

    public ApiException(HttpStatus status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public HttpStatus status() {
        return status;
    }

    public String code() {
        return code;
    }

    public static ApiException badRequest(String code, String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, code, message);
    }

    public static ApiException forbidden(String code, String message) {
        return new ApiException(HttpStatus.FORBIDDEN, code, message);
    }

    public static ApiException notFound(String message) {
        return new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", message);
    }

    /** 데이터 연결이 아직 없는 업무 모듈. 성공(200)·빈 목록으로 가장하지 않는다. */
    public static ApiException notConnected(String message) {
        return new ApiException(HttpStatus.NOT_IMPLEMENTED, "MODULE_NOT_CONNECTED", message);
    }

    public static ApiException conflict(String code, String message) {
        return new ApiException(HttpStatus.CONFLICT, code, message);
    }
}
