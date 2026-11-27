package com.smoa.bootstrap;

import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import com.smoa.config.LibraryContext;
import com.smoa.module.mapper.RecordsMapper;

/**
 * local/prod 기동 시 SMOA_LIBRARY_ID 가 LIBMSTR 에 있고 사용 중인지 읽기 전용으로 확인한다. 없으면 기동 실패
 * (다른 자료실을 자동으로 고르거나 빈 자료실로 대신 시작하지 않는다). 쓰기 없음.
 */
@Component
@Profile({"local", "prod"})
public class LibraryVerifier implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(LibraryVerifier.class);

    private final RecordsMapper mapper;
    private final LibraryContext library;

    public LibraryVerifier(RecordsMapper mapper, LibraryContext library) {
        this.mapper = mapper;
        this.library = library;
    }

    @Override
    public void run(ApplicationArguments args) {
        Map<String, Object> row = mapper.selectLibrary(library.id());
        if (row == null) {
            throw new IllegalStateException("LIBMSTR 에 설정한 자료실(SMOA_LIBRARY_ID)이 없습니다. 값을 확인하세요. 다른 자료실을 자동으로 선택하지 않습니다.");
        }
        Object active = row.get("active");
        boolean on = active instanceof Boolean b ? b : active instanceof Number n && n.intValue() != 0;
        if (!on) {
            throw new IllegalStateException("설정한 자료실이 사용 중(USE_IND=Y)이 아닙니다.");
        }
        log.info("업무 자료실 확인 완료");
    }
}
