package com.smoa.web;

import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

import com.smoa.common.ApiError;
import com.smoa.common.ApiError.FieldIssue;
import com.smoa.common.ApiException;

/** 모든 오류를 {code, message} JSON 으로 통일한다. 스택 트레이스·SQL·입력 원문은 응답에 넣지 않는다. */
@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiError> handleApi(ApiException e) {
        return ResponseEntity.status(e.status()).body(ApiError.of(e.code(), e.getMessage()));
    }

    /** 인증·인가 예외는 Spring Security 의 401/403 처리기로 넘긴다. */
    @ExceptionHandler({AccessDeniedException.class, AuthenticationException.class})
    public void rethrowSecurity(RuntimeException e) {
        throw e;
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> handleUnexpected(Exception e) {
        log.error("처리되지 않은 오류", e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(ApiError.of("INTERNAL_ERROR", "서버 오류가 발생했습니다."));
    }

    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(MethodArgumentNotValidException ex,
            HttpHeaders headers, HttpStatusCode status, WebRequest request) {
        // 거부된 입력 값(비밀번호 등)은 응답에 넣지 않고 필드 이름과 규칙 메시지만 알린다.
        List<FieldIssue> fields = ex.getBindingResult().getFieldErrors().stream()
                .map(f -> new FieldIssue(f.getField(), f.getDefaultMessage()))
                .toList();
        return ResponseEntity.badRequest()
                .body(new ApiError("VALIDATION_FAILED", "요청 값이 올바르지 않습니다.", fields));
    }

    @Override
    protected ResponseEntity<Object> handleExceptionInternal(Exception ex, Object body, HttpHeaders headers,
            HttpStatusCode statusCode, WebRequest request) {
        HttpStatus status = HttpStatus.resolve(statusCode.value());
        String code = status == null ? "ERROR" : status.name();
        String message = switch (statusCode.value()) {
            case 400 -> "요청 형식이 올바르지 않습니다.";
            case 404 -> "요청한 자원을 찾을 수 없습니다.";
            case 405 -> "허용되지 않는 요청 방식입니다.";
            case 415 -> "지원하지 않는 요청 형식입니다.";
            default -> "요청을 처리할 수 없습니다.";
        };
        return ResponseEntity.status(statusCode).headers(headers).body(ApiError.of(code, message));
    }
}
