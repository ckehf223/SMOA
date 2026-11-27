package com.smoa.config;

import java.util.regex.Pattern;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

/**
 * 이 서버가 다루는 자료실(LIBMSTR.LIB_ID). 환경 변수 SMOA_LIBRARY_ID(smoa.storage.library-id)로 <b>명시</b>해야 하며
 * 여러 자료실 중 첫 번째를 자동으로 고르지 않는다. 비어 있거나 형식이 올바르지 않으면 DB 에 연결하기 전에 기동이 실패한다.
 * 모든 업무 SQL 은 이 값을 LIB_ID 조건으로 쓴다(요청에서 받지 않는다).
 */
@Component
@Profile({"local", "prod"})
public class LibraryContext {

    private static final Pattern FORMAT = Pattern.compile("[\\p{L}\\p{N}_.:@-]{1,60}");

    private final String id;

    public LibraryContext(SmoaProperties properties) {
        String value = properties.storage().libraryId() == null ? "" : properties.storage().libraryId().strip();
        if (value.isEmpty()) {
            throw new IllegalStateException("업무 자료실이 지정되지 않았습니다. 환경 변수 SMOA_LIBRARY_ID(자료실 LIB_ID)를 지정하세요. "
                    + "여러 자료실 중 하나를 자동으로 선택하지 않습니다.");
        }
        if (!FORMAT.matcher(value).matches()) {
            throw new IllegalStateException("SMOA_LIBRARY_ID 형식이 올바르지 않습니다(문자·숫자·._:@- 1~60자).");
        }
        this.id = value;
    }

    public String id() {
        return id;
    }
}
