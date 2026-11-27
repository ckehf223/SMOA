package com.smoa.bootstrap;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSessionFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import com.smoa.account.persistence.AccountMapper;
import com.smoa.afterreport.AfterReportMapper;
import com.smoa.analysis.AnalysisMapper;
import com.smoa.callingsheet.persistence.CallingSheetMapper;
import com.smoa.organization.persistence.BusinessMapper;
import com.smoa.module.mapper.AnalyticsMapper;
import com.smoa.module.mapper.CallingMapper;
import com.smoa.module.mapper.GoalsMapper;
import com.smoa.module.mapper.ImportsMapper;
import com.smoa.module.mapper.OrganizationMapper;
import com.smoa.module.mapper.RecordsMapper;
import com.smoa.module.mapper.SocialingMapper;
import com.smoa.permission.persistence.PackageMapper;
import com.smoa.program.persistence.ProgramMapper;
import com.smoa.reference.persistence.ReferenceMapper;
import com.smoa.settings.persistence.LibrarySettingsMapper;

/**
 * local/prod 기동 시 실제 DB를 사용하는 Mapper의
 * 모든 인터페이스 메서드에 대응하는 XML statement 와 필수 resultMap 이 있는지 검사한다. 하나라도 없으면 누락 목록과 함께 기동을 중단한다.
 * 미사용 Mapper 자리표시자는 계약에서 제외한다({@link #PENDING_MODULES}).
 * 메모리 저장소로 조용히 대체하지 않으며, DB 에 연결하지 않고(SqlSessionFactory 설정만 확인) 검사한다.
 */
@Component
@Profile({"local", "prod"})
public class MapperContractVerifier {

    /** Mapper 인터페이스 → 필수 resultMap id(없으면 빈 목록). */
    static final Map<Class<?>, List<String>> CONTRACTS = Map.ofEntries(
            Map.entry(ProgramMapper.class, List.of("programRow")),
            Map.entry(PackageMapper.class, List.of("packageRow", "packagePermissionRow", "packageDistrictRow")),
            Map.entry(AccountMapper.class, List.of("accountRow")),
            Map.entry(AfterReportMapper.class, List.of()),
            Map.entry(ReferenceMapper.class, List.of("regionRow", "districtRow")),
            Map.entry(RecordsMapper.class, List.of()),
            Map.entry(AnalyticsMapper.class, List.of()),
            Map.entry(AnalysisMapper.class, List.of("finding", "activity")),
            Map.entry(CallingMapper.class, List.of()),
            Map.entry(BusinessMapper.class, List.of()),
            Map.entry(CallingSheetMapper.class, List.of()),
            Map.entry(LibrarySettingsMapper.class, List.of()));

    /** 아직 이식하지 않은 모듈의 Mapper(statement 없음, 검사 대상 아님). 해당 프로그램은 501 MODULE_NOT_CONNECTED. */
    static final List<Class<?>> PENDING_MODULES = List.of(SocialingMapper.class,
            ImportsMapper.class, GoalsMapper.class, OrganizationMapper.class);

    public MapperContractVerifier(SqlSessionFactory sqlSessionFactory) {
        Configuration configuration = sqlSessionFactory.getConfiguration();
        List<String> missing = new ArrayList<>();
        CONTRACTS.forEach((contract, resultMaps) -> {
            for (Method method : contract.getDeclaredMethods()) {
                String id = contract.getName() + "." + method.getName();
                if (!configuration.hasStatement(id, false)) {
                    missing.add("statement " + id);
                }
            }
            for (String resultMap : resultMaps) {
                if (!configuration.hasResultMap(contract.getName() + "." + resultMap)) {
                    missing.add("resultMap " + contract.getName() + "." + resultMap);
                }
            }
        });
        if (!missing.isEmpty()) {
            missing.sort(String::compareTo);
            throw new IllegalStateException("MyBatis Mapper 계약이 완성되지 않아 시작할 수 없습니다. "
                    + "mapper XML 에 다음 항목을 작성하세요(상세: docs/MODULE_INTEGRATION_GUIDE.md). "
                    + "메모리 저장소로 자동 전환하지 않습니다. 누락: " + missing);
        }
    }
}
