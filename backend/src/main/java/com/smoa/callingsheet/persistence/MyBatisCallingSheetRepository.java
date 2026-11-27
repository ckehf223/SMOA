package com.smoa.callingsheet.persistence;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.LongFunction;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import com.smoa.audit.AuditStamp;
import com.smoa.callingsheet.CallingSheetRepository;
import com.smoa.callingsheet.RoundEntry;
import com.smoa.callingsheet.ScopeSpec;
import com.smoa.callingsheet.SheetField;
import com.smoa.callingsheet.SheetQuery;
import com.smoa.callingsheet.SheetRow;
import com.smoa.config.LibraryContext;
import com.smoa.crypto.ContactVault.PhoneSecret;
import com.smoa.module.mapper.RecordsMapper;

@Repository
@Profile({"local", "prod"})
public class MyBatisCallingSheetRepository implements CallingSheetRepository {

    private static final int ROUND_PAGE_SIZE = 500;
    private static final String TARGET_KIND = "CALLSHEET";

    private final CallingSheetMapper mapper;
    private final RecordsMapper auditMapper;
    private final LibraryContext library;

    public MyBatisCallingSheetRepository(CallingSheetMapper mapper, RecordsMapper auditMapper, LibraryContext library) {
        this.mapper = mapper;
        this.auditMapper = auditMapper;
        this.library = library;
    }

    @Override
    public String libraryId() {
        return library.id();
    }

    @Override
    @Transactional(readOnly = true)
    public Page search(SheetQuery query, ScopeSpec scope) {
        Map<String, Object> filters = filters(query);
        var districts = scope.districtPairs();
        long count = mapper.countSheets(libraryId(), filters, scope.unassigned(), districts);
        if (count <= query.offset()) {
            return new Page(List.of(), count);
        }
        var rows = mapper.selectSheets(libraryId(), filters, scope.unassigned(), districts, query.offset(), query.size());
        return new Page(withRounds(rows), count);
    }

    @Override
    @Transactional(readOnly = true)
    public List<SheetRow> findAll(SheetQuery query, ScopeSpec scope, int max) {
        if (max <= 0) {
            return List.of();
        }
        var rows = mapper.selectSheets(libraryId(), filters(query), scope.unassigned(), scope.districtPairs(), 0, max);
        return withRounds(rows);
    }

    @Override
    @Transactional(readOnly = true)
    public Stats stats(SheetQuery query, ScopeSpec scope) {
        Map<String, Object> filters = filters(query);
        var districts = scope.districtPairs();
        var summary = mapper.selectStatsSummary(libraryId(), filters, scope.unassigned(), districts);
        var byStatus = counts(mapper.selectStatsByStatus(libraryId(), filters, scope.unassigned(), districts));
        var byResult = counts(mapper.selectStatsByResult(libraryId(), filters, scope.unassigned(), districts));
        var byDistrict = mapper.selectStatsByDistrict(libraryId(), filters, scope.unassigned(), districts).stream()
                .map(row -> new DistrictCount(str(row, "regionCode"), str(row, "districtCode"), num(row.get("cnt"))))
                .toList();
        return new Stats(num(summary.get("total")), num(summary.get("unassigned")), num(summary.get("manpik")),
                byStatus, byDistrict, byResult);
    }

    private static List<Count> counts(List<Map<String, Object>> rows) {
        return rows.stream().map(row -> new Count(str(row, "labelValue"), num(row.get("cnt")))).toList();
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<SheetRow> find(long id, ScopeSpec scope, boolean includeDeleted) {
        var row = mapper.selectSheetById(libraryId(), id, includeDeleted, scope.unassigned(), scope.districtPairs());
        return row == null ? Optional.empty() : Optional.of(withRounds(List.of(row)).getFirst());
    }

    @Override
    public SheetRow insert(NewSheet sheet, LongFunction<Secrets> sealer, AuditStamp stamp) {
        Map<String, Object> values = writeParams(stamp);
        putValues(values, sheet.values());
        if (mapper.insertSheet(values) != 1 || values.get("id") == null) {
            throw new IllegalStateException("콜링시트 행 키를 받지 못했습니다.");
        }
        long id = num(values.get("id"));
        Secrets secrets = sealer == null ? Secrets.NONE : sealer.apply(id);
        if (secrets.phone() != null || secrets.sourceEnc() != null) {
            putPhone(values, secrets.phone());
            values.put("sourceEnc", secrets.sourceEnc());
            if (mapper.attachSecrets(values) != 1) {
                throw new IllegalStateException("콜링시트 연락처를 저장하지 못했습니다.");
            }
        }
        sheet.rounds().forEach(round -> saveRound(id, round, stamp));
        return readAfterWrite(id);
    }

    @Override
    public Result update(long id, Update update, long expectedVersion, ScopeSpec scope, AuditStamp stamp) {
        Map<String, Object> values = mutationParams(id, expectedVersion, scope, stamp);
        putValues(values, update.changes());
        values.put("changed", update.changes().keySet().stream().map(SheetField::key).toList());
        values.put("phoneChange", update.phoneChange());
        putPhone(values, update.phone());
        values.put("sourceChange", update.sourceChange());
        values.put("sourceEnc", update.sourceEnc());
        if (mapper.updateSheet(values) != 1) {
            return find(id, scope, false).isPresent() ? Result.of(Outcome.CONFLICT) : Result.of(Outcome.NOT_FOUND);
        }
        update.roundRemovals().forEach(code -> mapper.deleteRound(libraryId(), id, code));
        update.roundUpserts().forEach(round -> saveRound(id, round, stamp));
        return Result.ok(readAfterWrite(id));
    }

    @Override
    public Result setDeleted(long id, boolean deleted, long expectedVersion, ScopeSpec scope, AuditStamp stamp) {
        Map<String, Object> values = mutationParams(id, expectedVersion, scope, stamp);
        values.put("fromInd", deleted ? "N" : "Y");
        values.put("toInd", deleted ? "Y" : "N");
        if (mapper.updateDeleted(values) != 1) {
            return find(id, scope, true).filter(row -> row.deleted() != deleted).isPresent()
                    ? Result.of(Outcome.CONFLICT) : Result.of(Outcome.NOT_FOUND);
        }
        return Result.ok(readAfterWrite(id));
    }

    @Override
    public List<String> distinctValues(String field, ScopeSpec scope, int limit) {
        var districts = scope.districtPairs();
        return switch (field) {
            case "callStatus" -> mapper.selectDistinctStatuses(libraryId(), scope.unassigned(), districts, limit);
            case "callResult" -> mapper.selectDistinctResults(libraryId(), scope.unassigned(), districts, limit);
            default -> throw new IllegalArgumentException("지원하지 않는 콜링시트 필드입니다.");
        };
    }

    @Override
    public boolean targetVisible(long targetId, ScopeSpec scope) {
        return mapper.countTargetVisible(libraryId(), targetId, scope.unassigned(), scope.districtPairs()) == 1;
    }

    @Override
    public List<Lookup> targets(String q, ScopeSpec scope, int limit) {
        return lookups(mapper.selectTargets(libraryId(), like(q), scope.unassigned(), scope.districtPairs(), limit));
    }

    @Override
    public List<Lookup> members(String q, ScopeSpec scope, int limit) {
        return lookups(mapper.selectMembers(like(q), scope.unassigned(), scope.districtPairs(), limit));
    }

    @Override
    public boolean memberVisible(String employeeId, ScopeSpec scope) {
        return mapper.countMember(employeeId, scope.unassigned(), scope.districtPairs()) == 1;
    }

    private static List<Lookup> lookups(List<Map<String, Object>> rows) {
        return rows.stream().map(row -> new Lookup(str(row, "id"), str(row, "name"), str(row, "code"),
                str(row, "regionCode"), str(row, "districtCode"))).toList();
    }

    @Override
    public void lockForWrite() {
        if (auditMapper.lockLibrary(libraryId()) == null) {
            throw new IllegalStateException("콜링시트 자료실을 찾을 수 없습니다.");
        }
    }

    @Override
    public void appendAudit(AuditEntry entry, AuditStamp stamp) {
        var last = mapper.selectLastChangeLogForUpdate(libraryId());
        long seq = last == null ? 1 : num(last.get("seq")) + 1;
        String previous = last == null ? null : str(last, "hash");
        Map<String, Object> values = writeParams(stamp);
        values.put("seq", seq);
        values.put("action", entry.action());
        values.put("targetKind", TARGET_KIND);
        values.put("targetId", Long.toString(entry.sheetId()));
        values.put("actorId", entry.actorId());
        values.put("actorName", entry.actorName());
        values.put("beforeJson", entry.beforeJson());
        values.put("afterJson", entry.afterJson());
        values.put("prevHash", previous);
        values.put("entryHash", hash(String.join("|", nz(previous), Long.toString(seq), entry.action(), TARGET_KIND,
                Long.toString(entry.sheetId()), nz(entry.actorId()), stamp.utcNow().toString(),
                nz(entry.beforeJson()), nz(entry.afterJson()))));
        if (auditMapper.insertChangeLog(values) != 1) {
            throw new IllegalStateException("콜링시트 변경 이력을 저장하지 못했습니다.");
        }
    }

    private Map<String, Object> writeParams(AuditStamp stamp) {
        Map<String, Object> values = new HashMap<>();
        values.put("libId", libraryId());
        values.put("sysUserId", stamp.userId());
        values.put("sysIp", stamp.ip());
        values.put("sysAt", stamp.utcNow());
        return values;
    }

    private Map<String, Object> mutationParams(long id, long expectedVersion, ScopeSpec scope, AuditStamp stamp) {
        Map<String, Object> values = writeParams(stamp);
        values.put("id", id);
        values.put("expectedVersion", expectedVersion);
        values.put("scopeUnassigned", scope.unassigned());
        values.put("districts", scope.districtPairs());
        return values;
    }

    private static void putValues(Map<String, Object> params, Map<SheetField, Object> values) {
        values.forEach((field, value) -> params.put(field.key(), value));
    }

    private static void putPhone(Map<String, Object> values, PhoneSecret phone) {
        values.put("phoneEnc", phone == null ? null : phone.envelope());
        values.put("phoneLast4", phone == null ? null : phone.last4());
        values.put("phoneKeyVer", phone == null ? null : phone.keyVersion());
    }

    private void saveRound(long id, RoundEntry round, AuditStamp stamp) {
        Map<String, Object> values = writeParams(stamp);
        values.put("sheetId", id);
        values.put("code", round.code());
        values.put("label", round.label());
        values.put("callerUserId", round.callerUserId());
        values.put("callerName", nz(round.callerName()));
        mapper.upsertRound(values);
    }

    private SheetRow readAfterWrite(long id) {
        Map<String, Object> row = mapper.selectSheetAfterWrite(libraryId(), id);
        if (row == null) {
            throw new IllegalStateException("저장한 콜링시트 행을 확인하지 못했습니다.");
        }
        return withRounds(List.of(row)).getFirst();
    }

    private List<SheetRow> withRounds(List<Map<String, Object>> rows) {
        List<Long> ids = rows.stream().map(row -> num(row.get("id"))).toList();
        Map<Long, List<RoundEntry>> rounds = new HashMap<>();
        for (int from = 0; from < ids.size(); from += ROUND_PAGE_SIZE) {
            List<Long> slice = ids.subList(from, Math.min(from + ROUND_PAGE_SIZE, ids.size()));
            for (Map<String, Object> round : mapper.selectRounds(libraryId(), slice)) {
                long id = num(round.get("sheetId"));
                rounds.computeIfAbsent(id, ignored -> new ArrayList<>()).add(
                        new RoundEntry(str(round, "code"), str(round, "label"), str(round, "callerUserId"),
                                str(round, "callerName")));
            }
        }
        return rows.stream().map(row -> toSheet(row, rounds.get(num(row.get("id"))))).toList();
    }

    private static SheetRow toSheet(Map<String, Object> r, List<RoundEntry> rounds) {
        Long targetId = r.get("targetId") == null ? null : num(r.get("targetId"));
        return new SheetRow(num(r.get("id")), targetId, str(r, "callStatus"), str(r, "foundDate"),
                str(r, "callResult"), str(r, "targetName"), str(r, "introducerId"), str(r, "introducerName"),
                str(r, "regionCode"), str(r, "districtCode"), str(r, "sexCode"), str(r, "ageText"), str(r, "residence"),
                str(r, "preferredPlace"), str(r, "notes"), str(r, "consultTopic"), str(r, "manpikConfirmedAt"),
                str(r, "manpikInfo"), str(r, "assignedUserId"), str(r, "assignedUserName"), str(r, "phoneLast4"),
                rounds, num(r.get("rowVersion")), "Y".equals(str(r, "deleted")), str(r, "createdAt"), str(r, "updatedAt"),
                str(r, "sourceEnc"));
    }

    private static Map<String, Object> filters(SheetQuery q) {
        Map<String, Object> filters = new HashMap<>();
        filters.put("deleted", q.trash() ? "Y" : "N");
        filters.put("qLike", like(q.q()));
        filters.put("qLast4", q.q() != null && q.q().matches("[0-9]{4}") ? q.q() : null);
        filters.put("regionCode", q.regionCode());
        filters.put("districtCode", q.districtCode());
        filters.put("callStatus", q.callStatus());
        filters.put("callResult", q.callResult());
        filters.put("foundFrom", q.foundFrom());
        filters.put("foundTo", q.foundTo());
        filters.put("createdFrom", q.createdFromUtc());
        filters.put("assignedUserId", q.assignedUserId());
        filters.put("assigned", q.assigned());
        filters.put("manpik", q.manpik());
        filters.put("roundCode", q.roundCode());
        filters.put("roundState", q.roundState());
        filters.put("phoneLast4", q.phoneLast4());
        filters.put("sort", q.sort());
        filters.put("desc", q.desc());
        return filters;
    }

    private static String like(String q) {
        return q == null ? null : "%" + q.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
    }

    private static String str(Map<String, Object> row, String key) {
        Object value = row.get(key);
        return value == null ? null : value.toString();
    }

    private static long num(Object value) {
        return ((Number) value).longValue();
    }

    private static String nz(String value) {
        return value == null ? "" : value;
    }

    private static String hash(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
