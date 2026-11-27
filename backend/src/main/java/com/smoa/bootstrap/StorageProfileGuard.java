package com.smoa.bootstrap;

import java.util.Arrays;
import java.util.List;
import java.util.Set;

import org.springframework.boot.context.event.ApplicationEnvironmentPreparedEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.core.Ordered;

/**
 * 저장소 프로파일을 반드시 하나만 명시하게 한다. 컨텍스트(DataSource 포함)가 만들어지기 전에 검사하므로
 * 프로파일이 없을 때 DB 연결이나 메모리 저장소로의 조용한 전환이 일어나지 않는다.
 * META-INF/spring.factories 로 등록한다.
 */
public class StorageProfileGuard implements ApplicationListener<ApplicationEnvironmentPreparedEvent>, Ordered {

    public static final String LOCAL_MEMORY = "local-memory";
    public static final String LOCAL = "local";
    public static final String PROD = "prod";
    static final Set<String> STORAGE_PROFILES = Set.of(LOCAL_MEMORY, LOCAL, PROD);

    @Override
    public void onApplicationEvent(ApplicationEnvironmentPreparedEvent event) {
        List<String> active = Arrays.stream(event.getEnvironment().getActiveProfiles())
                .filter(STORAGE_PROFILES::contains)
                .distinct()
                .toList();
        if (active.size() != 1) {
            throw new StorageProfileException(
                    "저장소 프로파일을 정확히 하나 지정해야 합니다(local-memory | local | prod). 현재: "
                            + (active.isEmpty() ? "없음" : active)
                            + ". 예: --spring.profiles.active=local-memory. 프로파일이 없을 때 메모리 모드로 자동 전환하지 않습니다.");
        }
    }

    /** 환경 후처리기(application-*.yml 로딩)가 끝난 뒤 검사한다. */
    @Override
    public int getOrder() {
        return Ordered.LOWEST_PRECEDENCE;
    }

    public static class StorageProfileException extends IllegalStateException {
        public StorageProfileException(String message) {
            super(message);
        }
    }
}
