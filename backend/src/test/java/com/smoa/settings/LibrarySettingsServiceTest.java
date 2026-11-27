package com.smoa.settings;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.smoa.access.AccessGrant;
import com.smoa.account.Account;
import com.smoa.common.ApiException;
import com.smoa.config.LibraryContext;
import com.smoa.module.mapper.RecordsMapper;
import com.smoa.permission.ActionPermission;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.records.RecordRepository;
import com.smoa.settings.persistence.LibrarySettingsMapper;

class LibrarySettingsServiceTest {
    private static final String LIBRARY = "fixture-library";
    private final LibrarySettingsMapper mapper = mock(LibrarySettingsMapper.class);
    private final LibraryContext library = mock(LibraryContext.class);
    private final RecordsMapper records = mock(RecordsMapper.class);
    private final RecordRepository audit = mock(RecordRepository.class);
    private final LibrarySettingsService service = new LibrarySettingsService(library, mapper, records, audit);

    @Test
    void 지정_구역_계정은_편집_권한이_있어도_자료실_설정을_저장할_수_없다() {
        var grant = grant(DataScope.org(List.of(new DistrictKey("R1", "D1"))));
        assertThatThrownBy(() -> service.save(grant, 1, "default"))
                .isInstanceOf(ApiException.class).extracting("code").isEqualTo("SETTING_WRITE_SCOPE");
        verifyNoInteractions(mapper, records, audit);
    }

    @Test
    void 현재_설정에_맞는_버전만_저장하며_변경_전후_요일을_기록한다() {
        when(library.id()).thenReturn(LIBRARY);
        when(records.lockLibrary(LIBRARY)).thenReturn(List.of(LIBRARY));
        var earlier = Map.<String, Object>of("libraryName", "검증 자료실", "configCode", "weekStart",
                "weekStart", "\"0\"", "updatedAt", "2026-11-26T01:00:00");
        var changed = Map.<String, Object>of("libraryName", "검증 자료실", "configCode", "WEEK_START",
                "weekStart", "1", "updatedAt", "2026-11-26T01:00:01");
        when(mapper.selectLibraryWeekSettings(LIBRARY)).thenReturn(earlier, earlier, changed);
        var grant = grant(DataScope.all());

        assertThatThrownBy(() -> service.save(grant, 1, "default"))
                .isInstanceOf(ApiException.class).extracting("code").isEqualTo("SETTING_WRITE_CONFLICT");
        var saved = service.save(grant, 1, "weekStart:2026-11-26T01:00:00");
        assertThat(saved.weekStart()).isEqualTo(1);
        assertThat(saved.revision()).isEqualTo("WEEK_START:2026-11-26T01:00:01");
        verify(mapper).saveLibraryWeekStart(eq(LIBRARY), eq("1"), any());
        verify(audit).appendHistory(any(), eq("{\"weekStart\":0}"), eq("{\"weekStart\":1}"));
    }

    private static AccessGrant grant(DataScope scope) {
        var account = new Account("fixture", "user", "검증계정", "pkg", "hash", true, 1);
        return new AccessGrant(account, "pkg", "패키지", true, false,
                Map.of("settings", new ActionPermission(true, true, true, false)), Map.of(), scope);
    }
}
