package com.smoa.web;

import java.util.Arrays;

import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/** 현재 저장소 프로파일 안내. local-memory 는 종료 시 자료가 사라지므로 화면에 개발 모드로 표시한다. */
@Component
public class StorageInfo {

    private final String mode;

    public StorageInfo(Environment environment) {
        this.mode = Arrays.stream(environment.getActiveProfiles())
                .filter(p -> p.equals("local-memory") || p.equals("local") || p.equals("prod")).findFirst()
                .orElse("unknown");
    }

    public String mode() {
        return mode;
    }

    public boolean devMemory() {
        return "local-memory".equals(mode);
    }
}
