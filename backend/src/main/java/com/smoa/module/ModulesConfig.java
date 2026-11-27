package com.smoa.module;

import java.util.Set;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;

/**
 * 업무 모듈 등록 위치. 새 모듈은 여기에 Bean 을 추가하고, mapper 인터페이스·XML 과 frontend/assets/modules/&lt;id&gt;.js 를 함께 만든다
 * (절차: docs/MODULE_INTEGRATION_GUIDE.md). connectedProgramIds 는 실제로 업무 규칙과 데이터 연결이 구현된 프로그램만 적는다.
 */
@Configuration
public class ModulesConfig {

    private final boolean databaseBacked;

    public ModulesConfig(Environment environment) {
        databaseBacked = environment.acceptsProfiles(Profiles.of("local", "prod"));
    }

    /** 계정·패키지·프로그램 관리(identity/access). 실제 동작한다. */
    @Bean
    ProgramModule identityModule() {
        return new BasicProgramModule("identity", "계정·권한 관리", Set.of("users", "permissions", "programs"),
                Set.of("users", "permissions", "programs"), "");
    }

    @Bean
    ProgramModule analyticsModule() {
        return new BasicProgramModule("analytics", "현황·통계",
                Set.of("dashboard", "regionData", "memberData", "classData", "findingStats", "diagnostics",
                        "stagePerformance", "socialingStats", "callingStats"),
                databaseBacked ? Set.of("dashboard", "regionData", "memberData", "classData", "findingStats", "diagnostics",
                        "stagePerformance", "socialingStats", "callingStats")
                        : Set.of("dashboard", "findingStats", "diagnostics", "callingStats"),
                "com.smoa.module.mapper.AnalyticsMapper");
    }

    /** 대상자·활동·변경 이력·단계 이동 분석은 local-memory 에서 실제 동작한다. 지역활동기록은 미이식. */
    @Bean
    ProgramModule recordsModule() {
        return new BasicProgramModule("records", "기록 관리",
                Set.of("people", "activities", "regionalActivity", "stages", "history"),
                databaseBacked ? Set.of("people", "activities", "regionalActivity", "stages", "history")
                        : Set.of("people", "activities", "stages", "history"), "com.smoa.module.mapper.RecordsMapper");
    }

    @Bean
    ProgramModule afterReportModule() {
        Set<String> programs = Set.of("afterAll", "afterOrganizer", "afterParticipant");
        return new BasicProgramModule("afterReport", "사후", programs, programs,
                "com.smoa.afterreport.AfterReportMapper", "/assets/modules/after-report.js");
    }

    @Bean
    ProgramModule socialingModule() {
        return new BasicProgramModule("socialing", "소셜링", Set.of("socialingManage"),
                databaseBacked ? Set.of("socialingManage") : Set.of(), "com.smoa.organization.persistence.BusinessMapper");
    }

    @Bean
    ProgramModule callingModule() {
        return new BasicProgramModule("calling", "콜링", Set.of("callingManage"), Set.of("callingManage"),
                "com.smoa.module.mapper.CallingMapper");
    }

    @Bean
    ProgramModule importsModule() {
        return new BasicProgramModule("imports", "자료 작업(엑셀·일보)", Set.of("reports", "daily"),
                Set.of("reports", "daily"), "");
    }

    @Bean
    ProgramModule goalsModule() {
        return new BasicProgramModule("goals", "목표", Set.of("goals"),
                databaseBacked ? Set.of("goals") : Set.of(), "com.smoa.organization.persistence.BusinessMapper");
    }

    @Bean
    ProgramModule organizationModule() {
        return new BasicProgramModule("organization", "조직·코드·설정", Set.of("organization", "codes", "settings"),
                databaseBacked ? Set.of("organization", "codes", "settings") : Set.of(),
                "com.smoa.organization.persistence.BusinessMapper");
    }

    /** 메타데이터만 가진 모듈 구현. 모듈별 동작은 해당 모듈의 Controller/Service 가 담당한다. */
    record BasicProgramModule(String id, String title, Set<String> defaultProgramIds, Set<String> connectedProgramIds,
            String mapperNamespace, String frontendScript) implements ProgramModule {

        BasicProgramModule(String id, String title, Set<String> defaults, Set<String> connected, String mapper) {
            this(id, title, defaults, connected, mapper, "/assets/modules/" + id + ".js");
        }
    }
}
