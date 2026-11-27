package com.smoa.config;

import java.time.Duration;
import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import com.smoa.program.ProgramAction;
import com.smoa.program.ProgramCategory;

@ConfigurationProperties(prefix = "smoa")
public record SmoaProperties(
        @DefaultValue List<SeedProgram> seedPrograms,
        @DefaultValue Security security,
        @DefaultValue Bootstrap bootstrap,
        @DefaultValue Storage storage,
        @DefaultValue Contact contact) {

    /**
     * 기본 프로그램 정의. local-memory 에서는 가상 저장소 시드이고,
     * local/prod 에서는 부트스트랩이 명시적으로 켜진 최초 1회에만 없는 항목을 채우는 목록이다.
     */
    public record SeedProgram(
            String programId,
            String name,
            String group,
            ProgramCategory category,
            List<ProgramAction> actions,
            String page,
            String module,
            @DefaultValue("false") boolean superAdminOnly,
            @DefaultValue("true") boolean active,
            @DefaultValue("1000") int sortOrder) {
    }

    public record Security(
            @DefaultValue("12") int bcryptStrength,
            @DefaultValue("5") int loginMaxFailures,
            @DefaultValue("15m") Duration loginWindow,
            @DefaultValue("15m") Duration loginLockout,
            @DefaultValue("10000") int loginTrackerMaxEntries,
            @DefaultValue List<String> publicPaths) {
    }

    /**
     * 최초 총관리자. 값은 환경 변수에서만 온다.
     * local-memory: username/password 가 있으면 만든다(기존 동작).
     * local/prod DB: {@code enabled=true} 이고 {@code environment} 가 활성 프로파일과 같을 때만, USERMSTR 이 비어 있으면 1회 만든다.
     */
    public record Bootstrap(
            @DefaultValue("false") boolean enabled,
            @DefaultValue("") String environment,
            @DefaultValue("") String username,
            @DefaultValue("") String password) {
        @Override
        public String toString() {
            return "Bootstrap[enabled=" + enabled + ", environment=" + environment + ", username=" + username
                    + ", password=***]";
        }
    }

    /** 업무 자료실. local/prod 에서는 필수이며 자동 선택하지 않는다. */
    public record Storage(@DefaultValue("") String libraryId) {
    }

    /** 연락처 암호화 키 파일 경로(32바이트 파일). 값/내용은 로그에 남기지 않는다. */
    public record Contact(@DefaultValue("") String keyFile) {
        @Override
        public String toString() {
            return "Contact[keyFile=" + (keyFile == null || keyFile.isBlank() ? "(unset)" : "(set)") + "]";
        }
    }
}
