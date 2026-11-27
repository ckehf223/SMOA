package com.smoa.settings;

import java.time.ZoneOffset;
import java.util.Map;
import java.util.Objects;
import java.util.OptionalInt;
import java.util.regex.Pattern;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.smoa.access.AccessGrant;
import com.smoa.audit.AuditStamp;
import com.smoa.common.ApiException;
import com.smoa.config.LibraryContext;
import com.smoa.module.mapper.RecordsMapper;
import com.smoa.permission.ScopeType;
import com.smoa.program.ProgramAction;
import com.smoa.records.HistoryEntry;
import com.smoa.records.RecordRepository;
import com.smoa.settings.persistence.LibrarySettingsMapper;

@Service
@Profile({"local", "prod"})
public class LibrarySettingsService {
    private static final Pattern WEEK_START = Pattern.compile("(?:([0-6])|\"([0-6])\")");
    private static final String PROGRAM = "settings";
    private final LibraryContext library;
    private final LibrarySettingsMapper settings;
    private final RecordsMapper records;
    private final RecordRepository audit;

    public LibrarySettingsService(LibraryContext library, LibrarySettingsMapper settings, RecordsMapper records,
            RecordRepository audit) {
        this.library = library;
        this.settings = settings;
        this.records = records;
        this.audit = audit;
    }

    public record View(String libraryName, int weekStart, String revision, boolean writable) {
    }

    @Transactional(readOnly = true)
    public View read(AccessGrant grant) {
        return view(load(), writable(grant));
    }

    @Transactional
    public View save(AccessGrant grant, int weekStart, String revision) {
        if (!writable(grant)) {
            throw ApiException.forbidden("SETTING_WRITE_SCOPE", "자료실 전체 범위와 설정 편집 권한이 필요합니다.");
        }
        if (weekStart < 0 || weekStart > 6 || revision == null) {
            throw ApiException.badRequest("INVALID_LIBRARY_SETTINGS", "주 시작 요일과 조회 정보를 확인해 주세요.");
        }
        if (records.lockLibrary(library.id()).isEmpty()) {
            throw ApiException.notFound("자료실 설정을 찾을 수 없습니다.");
        }
        var before = load();
        var view = view(before, true);
        if (!view.revision().equals(revision)) {
            throw ApiException.conflict("SETTING_WRITE_CONFLICT", "자료실 설정이 변경되었습니다. 새로 조회해 주세요.");
        }
        if (parseWeekStart(before.get("weekStart")).orElse(-1) == weekStart) {
            return view;
        }
        var stamp = AuditStamp.current();
        settings.saveLibraryWeekStart(library.id(), Integer.toString(weekStart), stamp);
        var entry = new HistoryEntry(null, HistoryEntry.KIND_CHANGE, null, null, HistoryEntry.UPDATED, null, null,
                null, null, true, false, null, stamp.userId(), stamp.userName(),
                stamp.utcNow().atOffset(ZoneOffset.UTC).toString(), "settings.weekStart", "librarySettings", "WEEK_START");
        audit.appendHistory(entry, weekStartJson(view.weekStart()), weekStartJson(weekStart));
        return view(load(), true);
    }

    private Map<String, Object> load() {
        var row = settings.selectLibraryWeekSettings(library.id());
        if (row == null) {
            throw ApiException.notFound("자료실 설정을 찾을 수 없습니다.");
        }
        return row;
    }

    private static View view(Map<String, Object> row, boolean writable) {
        String revision = row.get("configCode") == null ? "default"
                : row.get("configCode") + ":" + Objects.toString(row.get("updatedAt"), "");
        return new View(Objects.toString(row.get("libraryName"), ""),
                parseWeekStart(row.get("weekStart")).orElse(0), revision, writable);
    }

    private static boolean writable(AccessGrant grant) {
        return grant.scope().type() == ScopeType.ALL
                && grant.canAll(PROGRAM, ProgramAction.ACCESS, ProgramAction.READ, ProgramAction.WRITE);
    }

    private static OptionalInt parseWeekStart(Object raw) {
        var match = WEEK_START.matcher(Objects.toString(raw, "").strip());
        return match.matches() ? OptionalInt.of(Integer.parseInt(match.group(1) != null ? match.group(1) : match.group(2)))
                : OptionalInt.empty();
    }

    private static String weekStartJson(int value) {
        return "{\"weekStart\":" + value + "}";
    }
}
