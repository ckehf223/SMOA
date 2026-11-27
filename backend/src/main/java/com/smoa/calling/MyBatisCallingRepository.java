package com.smoa.calling;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;

import com.smoa.audit.AuditStamp;
import com.smoa.calling.CallingRecord.Outcome;
import com.smoa.calling.CallingRecord.Round;
import com.smoa.calling.CallingRecord.Subject;
import com.smoa.config.LibraryContext;
import com.smoa.module.mapper.CallingMapper;
import com.smoa.module.mapper.RecordsMapper;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.permission.ScopeType;

@Repository
@Profile({"local", "prod"})
class MyBatisCallingRepository implements CallingRepository {
    private final CallingMapper mapper;
    private final RecordsMapper records;
    private final LibraryContext library;

    MyBatisCallingRepository(CallingMapper mapper, RecordsMapper records, LibraryContext library) {
        this.mapper = mapper;
        this.records = records;
        this.library = library;
    }

    @Override
    public List<CallingRecord> select(DataScope scope, Range range, int limit) {
        var params = scope(scope);
        params.put("from", range.from());
        params.put("to", range.to());
        params.put("region", range.regionCode());
        params.put("district", range.districtCode());
        params.put("limit", limit);
        return mapper.selectCallingRecords(params).stream().map(MyBatisCallingRepository::row).toList();
    }

    @Override
    public List<Option> options(DataScope scope) {
        return mapper.selectCallingOptions(scope(scope)).stream()
                .map(r -> new Option(value(r, "caller"), round(r))).toList();
    }

    @Override
    public Optional<CallingRecord> find(DataScope scope, String id) {
        var params = scope(scope);
        params.put("id", id);
        return Optional.ofNullable(mapper.selectCallingRecord(params)).map(MyBatisCallingRepository::row);
    }

    @Override
    public int weekStart() {
        String value = mapper.selectCallingWeekStart(library.id());
        if (value == null) return 0;
        var weekday = java.util.regex.Pattern.compile("^\\s*\"?([0-6])\"?\\s*$").matcher(value);
        return weekday.matches() ? Integer.parseInt(weekday.group(1)) : 0;
    }

    @Override
    public void lock() {
        if (records.lockLibrary(library.id()).isEmpty()) throw new IllegalStateException("콜링 자료실을 찾을 수 없습니다.");
    }

    @Override
    public String insert(CallingRecord record) {
        var params = fields(record);
        params.put("libId", library.id());
        if (mapper.insertCallingRecord(params) != 1 || params.get("id") == null) {
            throw new IllegalStateException("콜링 기록을 저장하지 못했습니다.");
        }
        return params.get("id").toString();
    }

    @Override
    public boolean update(DataScope scope, CallingRecord record, boolean replaceSubject) {
        var params = scope(scope);
        params.putAll(fields(record));
        params.put("id", record.id());
        params.put("expectedVersion", record.rowVersion());
        params.put("replaceSubject", replaceSubject);
        return mapper.updateCallingRecord(params) == 1;
    }

    @Override
    public boolean delete(DataScope scope, CallingRecord record) {
        var params = scope(scope);
        params.put("id", record.id());
        params.put("expectedVersion", record.rowVersion());
        return mapper.deleteCallingRecord(params) == 1;
    }

    private Map<String, Object> scope(DataScope dataScope) {
        Map<String, Object> params = new HashMap<>();
        params.put("libId", library.id());
        params.put("all", dataScope.unrestricted());
        params.put("unassigned", dataScope.type() == ScopeType.ALL);
        params.put("districts", dataScope.districts().stream().sorted()
                .map(key -> Map.of("regionCode", key.regionCode(), "districtCode", key.districtCode())).toList());
        return params;
    }

    private static Map<String, Object> fields(CallingRecord record) {
        Map<String, Object> params = new HashMap<>();
        Subject subject = record.subject();
        DistrictKey key = subject.district();
        params.put("personId", subject.id());
        params.put("personName", subject.name());
        params.put("personCode", subject.code());
        params.put("introducer", subject.introducer());
        params.put("regionCode", key == null ? null : key.regionCode());
        params.put("districtCode", key == null ? null : key.districtCode());
        params.put("className", subject.className());
        params.put("foundDate", subject.foundDate());
        params.put("date", record.date());
        params.put("time", record.time());
        params.put("caller", record.caller());
        params.put("roundNo", record.round().number());
        params.put("roundName", record.round().name());
        params.put("result", record.outcome().result());
        params.put("originalResult", record.outcome().original());
        params.put("reportedResult", record.outcome().reported());
        params.put("notes", record.notes());
        params.put("attemptHash", CallingAttempts.hash(record));
        AuditStamp stamp = AuditStamp.current();
        params.put("sysUserId", stamp.userId());
        params.put("sysIp", stamp.ip());
        params.put("sysAt", stamp.utcNow());
        return params;
    }

    private static CallingRecord row(Map<String, Object> row) {
        String region = value(row, "regionCode");
        String district = value(row, "districtCode");
        var key = DistrictKey.valid(region, district) ? new DistrictKey(region, district) : null;
        var subject = new Subject(value(row, "personId"), value(row, "personName"), value(row, "personCode"),
                value(row, "introducer"), key, value(row, "className"), date(row, "foundDate"),
                Boolean.TRUE.equals(row.get("personDeleted")) || "1".equals(value(row, "personDeleted")));
        String result = value(row, "result");
        String original = value(row, "originalResult");
        var outcome = new Outcome(CallingRules.RESULTS.contains(result == null ? "" : result) ? result : "기타",
                original != null ? original : CallingRules.RESULTS.contains(result == null ? "" : result) ? null : result,
                value(row, "reportedResult"));
        String time = value(row, "callTime");
        return new CallingRecord(value(row, "id"), ((Number) row.get("rowVersion")).longValue(), subject,
                date(row, "callDate"), time == null ? null : LocalTime.parse(time),
                value(row, "caller"), round(row), outcome, value(row, "notes"));
    }

    private static Round round(Map<String, Object> row) {
        return new Round(((Number) row.get("roundNo")).intValue(), CallingRules.mask(value(row, "roundName")));
    }

    private static LocalDate date(Map<String, Object> row, String key) {
        String value = value(row, key);
        return value == null ? null : LocalDate.parse(value);
    }

    private static String value(Map<String, Object> row, String key) {
        var value = row.get(key);
        return value == null ? null : value.toString();
    }
}
