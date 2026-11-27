package com.smoa.callingsheet;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.smoa.access.AccessGrant;
import com.smoa.account.Account;
import com.smoa.account.AccountRepository;
import com.smoa.account.UnitOfWork;
import com.smoa.audit.AuditStamp;
import com.smoa.callingsheet.CallingSheetRepository.AuditEntry;
import com.smoa.callingsheet.CallingSheetRepository.Lookup;
import com.smoa.callingsheet.CallingSheetRepository.NewSheet;
import com.smoa.callingsheet.CallingSheetRepository.Outcome;
import com.smoa.callingsheet.CallingSheetRepository.Page;
import com.smoa.callingsheet.CallingSheetRepository.Result;
import com.smoa.callingsheet.CallingSheetRepository.Secrets;
import com.smoa.callingsheet.CallingSheetRepository.Stats;
import com.smoa.callingsheet.CallingSheetRepository.Update;
import com.smoa.common.ApiException;
import com.smoa.crypto.ContactVault;
import com.smoa.crypto.ContactVault.PhoneSecret;
import com.smoa.permission.DistrictKey;
import com.smoa.program.ProgramAction;
import com.smoa.reference.District;
import com.smoa.reference.ReferenceRepository;

/**
 * 콜링시트 업무 규칙. 컨트롤러는 인증된 {@link AccessGrant} 와 요청 값만 넘기며, 범위(구역)·권한·검증·봉인은 모두 여기서 서버가 결정한다.
 * <ul>
 *   <li>범위: 매 호출마다 {@link ScopeSpec} 을 grant + 활성 구역으로 새로 계산한다. 요청의 지역·구역은 필터일 뿐 권한이 아니다.</li>
 *   <li>쓰기: 입력 전체를 먼저 검증한 뒤(허용 목록·길이·형식·참조) 저장한다. PATCH 는 키가 없으면 보존, 명시 null/빈 값이면 비움.
 *       기존 행 변경은 rowVersion 필수이며 다르면 409. 본표·회차·감사는 한 UnitOfWork 에서 처리한다.</li>
 *   <li>연락처: 일반 값은 전화번호 형태를 마스킹해 저장하고 원문은 ContactVault 로 봉인 보존한다. 원문·봉투는 응답·감사·예외에 없다.</li>
 * </ul>
 */
@Service
public class CallingSheetService {

    public static final String PROGRAM_ID = "callingSheet";
    public static final int MAX_BATCH = 100;

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern CODE = Pattern.compile("[\\p{L}\\p{N}_.:@-]{1,64}");
    private static final Pattern DIGITS = Pattern.compile("\\d{1,18}");
    private static final Set<String> BODY_KEYS = new LinkedHashSet<>();
    private static final Set<String> ROUND_KEYS = Set.of("code", "label", "callerUserId", "callerName", "remove");
    private static final LocalDate MIN_DATE = LocalDate.of(1900, 1, 1);
    private static final LocalDate MAX_DATE = LocalDate.of(2100, 12, 31);

    static {
        BODY_KEYS.addAll(SheetField.keys());
        BODY_KEYS.add("phone");
        BODY_KEYS.add("rounds");
        BODY_KEYS.add("rowVersion");
    }

    private final CallingSheetRepository repository;
    private final ReferenceRepository reference;
    private final AccountRepository accounts;
    private final ContactVault vault;
    private final UnitOfWork unitOfWork;

    public CallingSheetService(CallingSheetRepository repository, ReferenceRepository reference,
            AccountRepository accounts, ContactVault vault, UnitOfWork unitOfWork) {
        this.repository = repository;
        this.reference = reference;
        this.accounts = accounts;
        this.vault = vault;
        this.unitOfWork = unitOfWork;
    }

    // ================= 조회 =================

    public Map<String, Object> options(AccessGrant grant) {
        requireAction(grant, ProgramAction.READ);
        ScopeSpec scope = ScopeSpec.of(grant, reference);
        Map<String, Object> result = new LinkedHashMap<>();
        List<Map<String, Object>> districts = new ArrayList<>();
        for (District d : reference.districts()) {
            if (scope.districts().contains(d.key())) {
                districts.add(Map.of("regionCode", d.key().regionCode(), "districtCode", d.key().districtCode(), "name",
                        d.name()));
            }
        }
        result.put("districts", districts);
        result.put("unassignedAllowed", scope.unassigned());
        result.put("defaultRounds", RoundEntry.DEFAULT_CODES.stream()
                .map(c -> Map.of("code", c, "label", RoundEntry.defaultLabel(c))).toList());
        result.put("statuses", repository.distinctValues("callStatus", scope, 200));
        result.put("results", repository.distinctValues("callResult", scope, 200));
        boolean write = grant.can(PROGRAM_ID, ProgramAction.WRITE);
        result.put("canWrite", write);
        result.put("canExport", grant.can(PROGRAM_ID, ProgramAction.EXPORT));
        result.put("sortKeys", new TreeSet<>(SheetQuery.SORT_KEYS));
        result.put("fields", java.util.Arrays.stream(SheetField.values()).map(f -> Map.of("key", f.key(), "label",
                f.label(), "kind", f.kind().name(), "max", f.max())).toList());
        if (write) {
            // 쓰기 권한자에게만: 콜링 담당 선택용 활성 계정(내부 ID + 표시명만).
            result.put("accounts", accounts.findAll().stream().filter(Account::active)
                    .map(a -> Map.of("id", a.id(), "name", PhoneMasker.mask(a.displayName()).text())).toList());
            result.put("contactKeyAvailable", vault.available());
        }
        return result;
    }

    public SheetPage list(AccessGrant grant, Map<String, String> params) {
        requireAction(grant, ProgramAction.READ);
        SheetQuery query = parseQuery(grant, params, true);
        Page page = repository.search(query, ScopeSpec.of(grant, reference));
        return new SheetPage(page.rows(), page.total(), query.offset() / Math.max(1, query.size()) + 1, query.size(),
                query.sort(), query.desc());
    }

    public record SheetPage(List<SheetRow> items, long total, int page, int size, String sort, boolean desc) {
    }

    public SheetRow get(AccessGrant grant, long id, boolean includeDeleted) {
        requireAction(grant, ProgramAction.READ);
        if (includeDeleted) {
            requireAction(grant, ProgramAction.WRITE);
        }
        return repository.find(id, ScopeSpec.of(grant, reference), includeDeleted)
                .orElseThrow(() -> ApiException.notFound("자료를 찾을 수 없습니다."));
    }

    /** 같은 필터(페이지 제외) 전체 집합의 상태·구역·결과별 정확한 건수. 목록 총건수와 항상 같은 집합이다. */
    public Stats stats(AccessGrant grant, Map<String, String> params) {
        requireAction(grant, ProgramAction.READ);
        return repository.stats(parseQuery(grant, params, false), ScopeSpec.of(grant, reference));
    }

    /** 내보내기용 전체 행. 목록과 같은 필터·범위. 너무 많으면 거부한다(부분 파일로 가장하지 않음). */
    public List<SheetRow> exportRows(AccessGrant grant, Map<String, String> params) {
        requireAction(grant, ProgramAction.READ);
        requireAction(grant, ProgramAction.EXPORT);
        SheetQuery query = parseQuery(grant, params, false);
        List<SheetRow> rows = repository.findAll(query, ScopeSpec.of(grant, reference), SheetQuery.MAX_EXPORT_ROWS + 1);
        if (rows.size() > SheetQuery.MAX_EXPORT_ROWS) {
            throw ApiException.badRequest("TOO_MANY_ROWS", "내보낼 행이 너무 많습니다. 기간·구역 필터로 범위를 좁혀 주세요.");
        }
        return rows;
    }

    public List<Lookup> targets(AccessGrant grant, String q, int limit) {
        requireAction(grant, ProgramAction.WRITE);
        return repository.targets(trimOrNull(q, 100), ScopeSpec.of(grant, reference), clamp(limit, 1, 30, 20));
    }

    public List<Lookup> members(AccessGrant grant, String q, int limit) {
        requireAction(grant, ProgramAction.WRITE);
        return repository.members(trimOrNull(q, 100), ScopeSpec.of(grant, reference), clamp(limit, 1, 30, 20));
    }

    // ================= 쓰기 =================

    public SheetRow create(AccessGrant grant, Map<String, Object> body) {
        requireAction(grant, ProgramAction.WRITE);
        ScopeSpec scope = ScopeSpec.of(grant, reference);
        Parsed p = parse(body, true);
        if (p.rowVersion != null) {
            throw ApiException.badRequest("INVALID_FIELD", "새 행에는 rowVersion 을 보낼 수 없습니다.");
        }
        Map<SheetField, Object> values = new EnumMap<>(SheetField.class);
        for (SheetField f : SheetField.values()) {
            values.put(f, p.fields.containsKey(f) ? p.fields.get(f) : f.nullable() ? null : "");
        }
        if (isBlank((String) values.get(SheetField.TARGET_NAME))) {
            throw ApiException.badRequest("INVALID_FIELD", "대상자 이름은 필수입니다.");
        }
        checkDistrict((String) values.get(SheetField.REGION_CODE), (String) values.get(SheetField.DISTRICT_CODE), scope,
                true);
        List<RoundEntry> rounds = mergeRounds(List.of(), p.rounds, new ArrayList<>(), new ArrayList<>());
        checkReferences(values, rounds, p.fields.keySet(), scope);
        requireKeyIfNeeded(p);
        AuditStamp stamp = AuditStamp.current();
        return unitOfWork.execute(() -> {
            repository.lockForWrite();
            SheetRow created = repository.insert(new NewSheet(values, rounds),
                    id -> sealAll(id, p, null, p.fields.keySet()), stamp);
            repository.appendAudit(audit("callingSheet.create", created.id(), grant, null, createdJson(created)), stamp);
            return created;
        });
    }

    public SheetRow update(AccessGrant grant, long id, Map<String, Object> body) {
        requireAction(grant, ProgramAction.WRITE);
        ScopeSpec scope = ScopeSpec.of(grant, reference);
        AuditStamp stamp = AuditStamp.current();
        return unitOfWork.execute(() -> {
            repository.lockForWrite();
            Prepared prepared = prepare(grant, scope, id, body);
            return apply(grant, scope, prepared, stamp);
        });
    }

    /**
     * 여러 행을 한 번에 수정(예: 담당자 일괄 배정). 모든 항목을 먼저 검증(범위·버전·형식·참조·봉인 준비)하고 하나라도 실패하면
     * 아무것도 저장하지 않는다(DB 는 같은 트랜잭션, 메모리는 검증 후 반영). 항목 id 중복·최대 100건.
     */
    public List<SheetRow> batch(AccessGrant grant, List<Map<String, Object>> items) {
        requireAction(grant, ProgramAction.WRITE);
        if (items == null || items.isEmpty() || items.size() > MAX_BATCH) {
            throw ApiException.badRequest("INVALID_BATCH", "한 번에 1~" + MAX_BATCH + "건까지 수정할 수 있습니다.");
        }
        ScopeSpec scope = ScopeSpec.of(grant, reference);
        AuditStamp stamp = AuditStamp.current();
        return unitOfWork.execute(() -> repository.executeBatch(() -> {
            repository.lockForWrite();
            List<Prepared> prepared = new ArrayList<>();
            Set<Long> seen = new LinkedHashSet<>();
            for (Map<String, Object> item : items) {
                Object rawId = item == null ? null : item.get("id");
                long id = parseId(rawId);
                if (!seen.add(id)) {
                    throw ApiException.badRequest("INVALID_BATCH", "같은 행이 한 요청에 두 번 들어 있습니다.");
                }
                Map<String, Object> body = new LinkedHashMap<>(item);
                body.remove("id");
                prepared.add(prepare(grant, scope, id, body));
            }
            List<SheetRow> result = new ArrayList<>();
            for (Prepared p : prepared) {
                result.add(apply(grant, scope, p, stamp));
            }
            return result;
        }));
    }

    public SheetRow delete(AccessGrant grant, long id, Long rowVersion) {
        return setDeleted(grant, id, rowVersion, true);
    }

    public SheetRow undelete(AccessGrant grant, long id, Long rowVersion) {
        return setDeleted(grant, id, rowVersion, false);
    }

    private SheetRow setDeleted(AccessGrant grant, long id, Long rowVersion, boolean deleted) {
        requireAction(grant, ProgramAction.WRITE);
        if (rowVersion == null) {
            throw ApiException.badRequest("ROW_VERSION_REQUIRED", "rowVersion 이 필요합니다.");
        }
        ScopeSpec scope = ScopeSpec.of(grant, reference);
        AuditStamp stamp = AuditStamp.current();
        return unitOfWork.execute(() -> {
            repository.lockForWrite();
            Result r = repository.setDeleted(id, deleted, rowVersion, scope, stamp);
            if (r.outcome() == Outcome.NOT_FOUND) {
                throw ApiException.notFound("자료를 찾을 수 없습니다.");
            }
            if (r.outcome() == Outcome.CONFLICT) {
                throw versionConflict();
            }
            ObjectNode before = JSON.createObjectNode().put("rowVersion", rowVersion).put("deleted", !deleted);
            ObjectNode after = JSON.createObjectNode().put("rowVersion", r.row().rowVersion()).put("deleted", deleted);
            repository.appendAudit(audit(deleted ? "callingSheet.delete" : "callingSheet.undelete", id, grant,
                    before.toString(), after.toString()), stamp);
            return r.row();
        });
    }

    // ================= 수정 준비/적용 =================

    private record Prepared(long id, SheetRow current, long expectedVersion, Update update, boolean noop,
            List<String> changed) {
    }

    private Prepared prepare(AccessGrant grant, ScopeSpec scope, long id, Map<String, Object> body) {
        Parsed p = parse(body, false);
        if (p.rowVersion == null) {
            throw ApiException.badRequest("ROW_VERSION_REQUIRED", "rowVersion 이 필요합니다.");
        }
        SheetRow current = repository.find(id, scope, false)
                .orElseThrow(() -> ApiException.notFound("자료를 찾을 수 없습니다."));
        if (current.rowVersion() != p.rowVersion) {
            throw versionConflict();
        }
        // 현재 값과 같은 값은 변경이 아니다(마스킹된 값을 그대로 다시 보내도 봉인 보존본을 지우지 않는다).
        Map<SheetField, Object> changes = new EnumMap<>(SheetField.class);
        for (Map.Entry<SheetField, Object> e : p.fields.entrySet()) {
            if (!Objects.equals(current.value(e.getKey()), e.getValue())) {
                changes.put(e.getKey(), e.getValue());
            }
        }
        if (changes.containsKey(SheetField.TARGET_NAME) && isBlank((String) changes.get(SheetField.TARGET_NAME))) {
            throw ApiException.badRequest("INVALID_FIELD", "대상자 이름은 비울 수 없습니다.");
        }
        String region = changes.containsKey(SheetField.REGION_CODE) ? (String) changes.get(SheetField.REGION_CODE)
                : current.regionCode();
        String district = changes.containsKey(SheetField.DISTRICT_CODE) ? (String) changes.get(SheetField.DISTRICT_CODE)
                : current.districtCode();
        checkDistrict(region, district, scope,
                changes.containsKey(SheetField.REGION_CODE) || changes.containsKey(SheetField.DISTRICT_CODE));
        List<RoundEntry> upserts = new ArrayList<>();
        List<String> removals = new ArrayList<>();
        mergeRounds(current.rounds(), p.rounds, upserts, removals);
        checkReferences(changes, upserts, p.fields.keySet(), scope);
        Set<SheetField> touched = changes.keySet();
        Parsed effective = p.restrictedTo(touched);
        boolean noop = changes.isEmpty() && upserts.isEmpty() && removals.isEmpty() && !p.phonePresent;
        List<String> changed = new ArrayList<>();
        changes.keySet().forEach(f -> changed.add(f.key()));
        if (p.phonePresent) {
            changed.add("phone");
        }
        upserts.forEach(u -> changed.add("round:" + u.code()));
        removals.forEach(c -> changed.add("round:" + c));
        if (noop) {
            return new Prepared(id, current, p.rowVersion, null, true, changed);
        }
        requireKeyIfNeeded(effective);
        Secrets secrets = sealAll(id, effective, current, touched);
        boolean phoneChange = p.phonePresent;
        boolean sourceChange = effective.touchesPersonalText(touched);
        Update update = new Update(changes, upserts, removals, phoneChange, secrets.phone(), sourceChange,
                secrets.sourceEnc());
        return new Prepared(id, current, p.rowVersion, update, false, changed);
    }

    private SheetRow apply(AccessGrant grant, ScopeSpec scope, Prepared p, AuditStamp stamp) {
        if (p.noop()) {
            return p.current();
        }
        Result r = repository.update(p.id(), p.update(), p.expectedVersion(), scope, stamp);
        if (r.outcome() == Outcome.NOT_FOUND) {
            throw ApiException.notFound("자료를 찾을 수 없습니다.");
        }
        if (r.outcome() == Outcome.CONFLICT) {
            throw versionConflict();
        }
        ObjectNode before = JSON.createObjectNode().put("rowVersion", p.expectedVersion());
        ObjectNode after = JSON.createObjectNode().put("rowVersion", r.row().rowVersion());
        ArrayNode changed = after.putArray("changed");
        p.changed().forEach(changed::add);
        putDistrict(after, r.row());
        repository.appendAudit(audit("callingSheet.update", p.id(), grant, before.toString(), after.toString()), stamp);
        return r.row();
    }

    // ================= 파싱·검증 =================

    private record RoundInput(String code, boolean remove, boolean labelPresent, String label, boolean userPresent,
            String userId, boolean namePresent, String name) {
    }

    /** 검증이 끝난 요청. fields 는 정규화된 값(개인 문자열은 마스킹됨), masked 는 봉인할 원문 번호. */
    private static final class Parsed {
        final Map<SheetField, Object> fields = new EnumMap<>(SheetField.class);
        final Map<SheetField, List<String>> numbers = new EnumMap<>(SheetField.class);
        boolean phonePresent;
        String phone;
        final List<RoundInput> rounds = new ArrayList<>();
        Long rowVersion;

        boolean touchesPersonalText(Set<SheetField> touched) {
            return touched.stream().anyMatch(SheetField::personalText);
        }

        /** 실제로 바뀐 필드의 봉인 대상만 남긴 사본. */
        Parsed restrictedTo(Set<SheetField> touched) {
            Parsed copy = new Parsed();
            copy.phonePresent = phonePresent;
            copy.phone = phone;
            numbers.forEach((f, n) -> {
                if (touched.contains(f)) {
                    copy.numbers.put(f, n);
                }
            });
            return copy;
        }
    }

    private Parsed parse(Map<String, Object> body, boolean create) {
        if (body == null) {
            throw ApiException.badRequest("INVALID_BODY", "요청 본문이 필요합니다.");
        }
        for (String key : body.keySet()) {
            if (!BODY_KEYS.contains(key)) {
                throw ApiException.badRequest("INVALID_FIELD", "허용되지 않은 항목이 있습니다.");
            }
        }
        Parsed p = new Parsed();
        for (SheetField f : SheetField.values()) {
            if (!body.containsKey(f.key())) {
                continue;
            }
            Object value = normalize(f, body.get(f.key()));
            if (f.personalText() && value instanceof String s && !s.isEmpty()) {
                PhoneMasker.Masked masked = PhoneMasker.mask(s);
                if (masked.found()) {
                    p.numbers.put(f, masked.numbers());
                }
                value = masked.text();
            }
            p.fields.put(f, value);
        }
        if (body.containsKey("phone")) {
            p.phonePresent = true;
            Object raw = body.get("phone");
            if (raw == null || raw instanceof String s && s.isBlank()) {
                p.phone = null;
            } else if (raw instanceof String s) {
                ContactVault.digitsOf(s);   // 형식 오류는 값을 싣지 않는 400
                p.phone = s.strip();
            } else {
                throw ApiException.badRequest("INVALID_PHONE", "연락처 형식이 올바르지 않습니다(숫자 7~15자리).");
            }
        }
        if (body.containsKey("rowVersion")) {
            Object raw = body.get("rowVersion");
            if (!(raw instanceof Number n) || n.longValue() < 1) {
                throw ApiException.badRequest("INVALID_FIELD", "rowVersion 이 올바르지 않습니다.");
            }
            p.rowVersion = n.longValue();
        }
        if (body.containsKey("rounds")) {
            parseRounds(body.get("rounds"), p, create);
        }
        return p;
    }

    private static void parseRounds(Object raw, Parsed p, boolean create) {
        int limit = create ? RoundEntry.MAX_ROUNDS : RoundEntry.MAX_ROUNDS * 2;
        if (!(raw instanceof List<?> list) || list.size() > limit) {
            throw ApiException.badRequest("INVALID_ROUNDS", "회차 변경 목록이 올바르지 않습니다.");
        }
        Set<String> codes = new LinkedHashSet<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> m)) {
                throw ApiException.badRequest("INVALID_ROUNDS", "회차 항목이 올바르지 않습니다.");
            }
            for (Object key : m.keySet()) {
                if (!(key instanceof String k) || !ROUND_KEYS.contains(k)) {
                    throw ApiException.badRequest("INVALID_ROUNDS", "회차에 허용되지 않은 항목이 있습니다.");
                }
            }
            Object codeRaw = m.get("code");
            if (!(codeRaw instanceof String code) || !RoundEntry.CODE.matcher(code.strip()).matches()) {
                throw ApiException.badRequest("INVALID_ROUNDS", "회차 코드가 올바르지 않습니다(영문·숫자·한글·_- 30자).");
            }
            code = code.strip();
            if (!codes.add(code)) {
                throw ApiException.badRequest("INVALID_ROUNDS", "같은 회차 코드가 중복되었습니다.");
            }
            boolean remove = Boolean.TRUE.equals(m.get("remove"));
            if (remove && create) {
                throw ApiException.badRequest("INVALID_ROUNDS", "새 행에서는 회차를 삭제할 수 없습니다.");
            }
            String label = roundText(m, "label", 60, "회차 이름");
            String name = roundText(m, "callerName", 100, "회차 담당자");
            String userId = null;
            if (m.get("callerUserId") != null) {
                if (!(m.get("callerUserId") instanceof String s) || !CODE.matcher(s.strip()).matches()
                        || s.strip().length() > 50) {
                    throw ApiException.badRequest("INVALID_ROUNDS", "회차 담당 계정 값이 올바르지 않습니다.");
                }
                userId = s.strip();
            }
            p.rounds.add(new RoundInput(code, remove, m.containsKey("label"), label, m.containsKey("callerUserId"),
                    userId, m.containsKey("callerName"), name));
        }
    }

    private static String roundText(Map<?, ?> m, String key, int max, String label) {
        Object v = m.get(key);
        if (v == null) {
            return null;
        }
        if (!(v instanceof String s)) {
            throw ApiException.badRequest("INVALID_ROUNDS", label + " 값이 올바르지 않습니다.");
        }
        String t = s.strip();
        if (t.length() > max || t.chars().anyMatch(Character::isISOControl)) {
            throw ApiException.badRequest("INVALID_ROUNDS", label + " 값이 올바르지 않습니다(" + max + "자 이내, 한 줄).");
        }
        if (PhoneMasker.containsPhone(t)) {
            throw ApiException.badRequest("INVALID_ROUNDS", label + "에는 연락처를 넣을 수 없습니다.");
        }
        return t.isEmpty() ? null : t;
    }

    /** 현재 회차에 요청을 코드 기준으로 합친다(요청에 없는 회차는 보존). 업서트/삭제 목록도 채운다. */
    private List<RoundEntry> mergeRounds(List<RoundEntry> current, List<RoundInput> inputs,
            List<RoundEntry> upserts, List<String> removals) {
        Map<String, RoundEntry> byCode = new LinkedHashMap<>();
        current.forEach(r -> byCode.put(r.code(), r));
        for (RoundInput in : inputs) {
            RoundEntry old = byCode.get(in.code());
            if (in.remove()) {
                if (old != null) {
                    byCode.remove(in.code());
                    removals.add(in.code());
                }
                continue;
            }
            String label = in.labelPresent() ? (in.label() == null ? RoundEntry.defaultLabel(in.code()) : in.label())
                    : old != null ? old.label() : RoundEntry.defaultLabel(in.code());
            String userId = in.userPresent() ? in.userId() : old == null ? null : old.callerUserId();
            String name = in.namePresent() ? in.name() : old == null ? null : old.callerName();
            if (in.userPresent() && !in.namePresent() && userId != null) {
                // 계정만 연결하고 이름을 보내지 않으면 계정 표시명을 스냅샷으로 쓴다(원본 표기를 보낸 경우는 그대로 보존).
                name = accounts.findById(userId).filter(Account::active).map(Account::displayName)
                        .map(n -> PhoneMasker.mask(n).text()).orElse(name);
            }
            if (userId == null && (name == null || name.isEmpty())) {
                // 담당자가 없는 회차 행은 두지 않는다(기본 1~5차의 빈 칸은 "행 없음").
                if (old != null) {
                    byCode.remove(in.code());
                    removals.add(in.code());
                }
                continue;
            }
            RoundEntry next = new RoundEntry(in.code(), label, userId, name == null ? "" : name);
            if (!next.equals(old)) {
                byCode.put(in.code(), next);
                upserts.add(next);
            }
        }
        if (byCode.size() > RoundEntry.MAX_ROUNDS) {
            throw ApiException.badRequest("INVALID_ROUNDS", "회차는 최대 " + RoundEntry.MAX_ROUNDS + "개입니다.");
        }
        return new ArrayList<>(byCode.values());
    }

    private Object normalize(SheetField f, Object raw) {
        if (raw == null) {
            return f.nullable() ? null : "";
        }
        if (f.kind() == SheetField.Kind.ID) {
            if (raw instanceof Number n && n.longValue() > 0 && n.doubleValue() == n.longValue()) {
                return n.longValue();
            }
            if (raw instanceof String s && DIGITS.matcher(s.strip()).matches() && Long.parseLong(s.strip()) > 0) {
                return Long.parseLong(s.strip());
            }
            if (raw instanceof String s && s.isBlank()) {
                return null;
            }
            throw invalid(f);
        }
        if (!(raw instanceof String s)) {
            throw invalid(f);
        }
        String t = f.kind() == SheetField.Kind.TEXT ? s.replace("\r\n", "\n").replace('\r', '\n').strip() : s.strip();
        if (t.length() > f.max()) {
            throw ApiException.badRequest("INVALID_FIELD", f.label() + " 값이 너무 깁니다(" + f.max() + "자 이내).");
        }
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            boolean control = Character.isISOControl(c);
            if (control && !(f.kind() == SheetField.Kind.TEXT && (c == '\n' || c == '\t'))) {
                throw invalid(f);
            }
        }
        if (t.isEmpty()) {
            return f.nullable() ? null : "";
        }
        return switch (f.kind()) {
            case LINE, TEXT -> t;
            case CODE -> {
                if (!CODE.matcher(t).matches()) {
                    throw invalid(f);
                }
                yield t;
            }
            case DATE -> parseDate(f, t).toString();
            case DATETIME -> parseDateTime(f, t);
            case ID -> throw invalid(f);
        };
    }

    private static LocalDate parseDate(SheetField f, String t) {
        try {
            LocalDate d = LocalDate.parse(t);
            if (d.isBefore(MIN_DATE) || d.isAfter(MAX_DATE)) {
                throw invalid(f);
            }
            return d;
        } catch (DateTimeParseException e) {
            throw invalid(f);
        }
    }

    /** yyyy-MM-dd(시각 없음 = 00:00:00), yyyy-MM-ddTHH:mm[:ss] 또는 공백 구분. */
    private static String parseDateTime(SheetField f, String t) {
        try {
            String s = t.replace(' ', 'T');
            LocalDateTime dt = s.length() == 10 ? LocalDate.parse(s).atStartOfDay()
                    : s.length() == 16 ? LocalDateTime.parse(s + ":00") : LocalDateTime.parse(s);
            if (dt.toLocalDate().isBefore(MIN_DATE) || dt.toLocalDate().isAfter(MAX_DATE)) {
                throw invalid(f);
            }
            return dt.withNano(0).format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss"));
        } catch (DateTimeParseException e) {
            throw invalid(f);
        }
    }

    private static ApiException invalid(SheetField f) {
        return ApiException.badRequest("INVALID_FIELD", f.label() + " 값이 올바르지 않습니다.");
    }

    private static void checkDistrict(String region, String district, ScopeSpec scope, boolean enforceScope) {
        if ((region == null) != (district == null)) {
            throw ApiException.badRequest("INVALID_FIELD", "지역과 구역은 함께 지정하거나 함께 비워야 합니다.");
        }
        if (region != null && !DistrictKey.valid(region, district)) {
            throw ApiException.badRequest("INVALID_FIELD", "지역·구역 형식이 올바르지 않습니다.");
        }
        if (enforceScope && !scope.covers(region, district)) {
            throw ApiException.forbidden("OUT_OF_SCOPE", "접근할 수 없는 구역입니다.");
        }
    }

    /**
     * 선택 연결(대상자·명부·계정)을 검증하고 계정 표시명 기본값을 채운다. 오류 메시지에 입력값을 넣지 않는다.
     * 연결은 참조일 뿐이며 연결된 대상자·명부 정보를 이 메뉴가 덮어쓰지 않는다.
     */
    private void checkReferences(Map<SheetField, Object> values, List<RoundEntry> rounds, Set<SheetField> requested,
            ScopeSpec scope) {
        Object target = values.get(SheetField.TARGET_ID);
        if (target instanceof Long id && !repository.targetVisible(id, scope)) {
            throw ApiException.badRequest("INVALID_TARGET", "연결할 대상자를 찾을 수 없습니다.");
        }
        Object member = values.get(SheetField.INTRO_EMPL_ID);
        if (member instanceof String id && !repository.memberVisible(id, scope)) {
            throw ApiException.badRequest("INVALID_MEMBER", "연결할 인도자(명부)를 찾을 수 없습니다.");
        }
        Object assigned = values.get(SheetField.ASSIGNED_USER_ID);
        if (assigned instanceof String id) {
            Account account = accounts.findById(id).filter(Account::active)
                    .orElseThrow(() -> ApiException.badRequest("INVALID_ACCOUNT", "연결할 계정을 찾을 수 없습니다."));
            if (requested.contains(SheetField.ASSIGNED_USER_ID) && !requested.contains(SheetField.ASSIGNED_USER_NAME)) {
                values.put(SheetField.ASSIGNED_USER_NAME, PhoneMasker.mask(account.displayName()).text());
            }
        }
        for (RoundEntry r : rounds) {
            if (r.callerUserId() != null && !accounts.findById(r.callerUserId()).filter(Account::active).isPresent()) {
                throw ApiException.badRequest("INVALID_ACCOUNT", "연결할 계정을 찾을 수 없습니다.");
            }
        }
    }

    // ================= 봉인 =================

    private void requireKeyIfNeeded(Parsed p) {
        boolean need = p.phonePresent && p.phone != null || p.numbers.values().stream().anyMatch(l -> !l.isEmpty());
        if (need && !vault.available()) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "CONTACT_KEY_UNAVAILABLE",
                    "연락처 암호화 키가 설정되지 않아 연락처를 저장할 수 없습니다. 관리자에게 문의하세요.");
        }
    }

    /** 확정된 행 ID 로 연락처와 자유 문자열 속 번호를 봉인한다. 기존 SOURCE_ENC 는 바뀐 필드만 교체해 합친다. */
    private Secrets sealAll(long id, Parsed p, SheetRow current, Set<SheetField> touched) {
        String lib = repository.libraryId();
        PhoneSecret phone = p.phonePresent && p.phone != null ? vault.seal(p.phone, CallingSheetAad.phone(lib, id)) : null;
        boolean personal = touched.stream().anyMatch(SheetField::personalText);
        String source = null;
        if (personal) {
            ObjectNode fields = existingSource(current);
            for (SheetField f : touched) {
                if (!f.personalText()) {
                    continue;
                }
                fields.remove(f.key());
                List<String> numbers = p.numbers.getOrDefault(f, List.of());
                if (!numbers.isEmpty()) {
                    ArrayNode array = fields.putArray(f.key());
                    for (int i = 0; i < numbers.size(); i++) {
                        array.add(vault.seal(numbers.get(i), CallingSheetAad.source(lib, id, f.key(), i)).envelope());
                    }
                }
            }
            if (fields.size() > 0) {
                ObjectNode root = JSON.createObjectNode().put("v", 1);
                root.set("f", fields);
                source = root.toString();
            }
        }
        return new Secrets(phone, source);
    }

    private static ObjectNode existingSource(SheetRow current) {
        if (current == null || current.sourceEnc() == null) {
            return JSON.createObjectNode();
        }
        try {
            var node = JSON.readTree(current.sourceEnc()).path("f");
            return node instanceof ObjectNode o ? o.deepCopy() : JSON.createObjectNode();
        } catch (java.io.IOException e) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "서버 오류가 발생했습니다.");
        }
    }

    // ================= 질의 파라미터 =================

    SheetQuery parseQuery(AccessGrant grant, Map<String, String> params, boolean paged) {
        String region = trimOrNull(params.get("regionCode"), 64);
        String district = trimOrNull(params.get("districtCode"), 64);
        if (region != null && !CODE.matcher(region).matches() || district != null && !CODE.matcher(district).matches()) {
            throw ApiException.badRequest("INVALID_QUERY", "구역 조건이 올바르지 않습니다.");
        }
        if ((region == null) != (district == null)) {
            throw ApiException.badRequest("INVALID_QUERY", "지역과 구역을 함께 지정하세요.");
        }
        String q = trimOrNull(params.get("q"), 100);
        String roundCode = trimOrNull(params.get("roundCode"), 30);
        if (roundCode != null && !RoundEntry.CODE.matcher(roundCode).matches()) {
            throw ApiException.badRequest("INVALID_QUERY", "회차 조건이 올바르지 않습니다.");
        }
        String last4 = trimOrNull(params.get("phoneLast4"), 4);
        if (last4 != null && !last4.matches("\\d{4}")) {
            throw ApiException.badRequest("INVALID_QUERY", "끝 네 자리는 숫자 4자리입니다.");
        }
        boolean trash = "true".equalsIgnoreCase(params.get("trash"));
        if (trash && !grant.can(PROGRAM_ID, ProgramAction.WRITE)) {
            throw ApiException.forbidden("FORBIDDEN", "이 기능에 대한 권한이 없습니다.");
        }
        String sort = trimOrNull(params.get("sort"), 30);
        if (sort != null && !SheetQuery.SORT_KEYS.contains(sort)) {
            throw ApiException.badRequest("INVALID_QUERY", "정렬 조건이 올바르지 않습니다.");
        }
        boolean desc = !"asc".equalsIgnoreCase(params.get("dir"));
        int size = clamp(intParam(params.get("size")), 1, SheetQuery.MAX_SIZE, 50);
        int page = Math.max(1, intParam(params.get("page")));
        long offset = (page - 1L) * size;
        if (paged && offset > Integer.MAX_VALUE) {
            throw ApiException.badRequest("INVALID_QUERY", "페이지 범위가 올바르지 않습니다.");
        }
        return new SheetQuery(q, region, district, trimOrNull(params.get("callStatus"), 60),
                trimOrNull(params.get("callResult"), 100), date(params.get("foundFrom")), date(params.get("foundTo")),
                date(params.get("createdFrom")), trimOrNull(params.get("assignedUserId"), 50),
                enumParam(params.get("assigned")), enumParam(params.get("manpik")), roundCode,
                roundCode == null ? null : "none".equals(params.get("roundState")) ? "none" : "has", last4, trash,
                sort == null ? "foundDate" : sort, desc, paged ? (int) offset : 0, paged ? size : 0);
    }

    private static String enumParam(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        if (!value.equals("any") && !value.equals("none")) {
            throw ApiException.badRequest("INVALID_QUERY", "조건 값이 올바르지 않습니다.");
        }
        return value;
    }

    private static LocalDate date(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(value.strip());
        } catch (DateTimeParseException e) {
            throw ApiException.badRequest("INVALID_QUERY", "날짜 조건이 올바르지 않습니다(yyyy-MM-dd).");
        }
    }

    private static int intParam(String value) {
        if (value == null || value.isBlank()) {
            return 0;
        }
        try {
            return Integer.parseInt(value.strip());
        } catch (NumberFormatException e) {
            throw ApiException.badRequest("INVALID_QUERY", "숫자 조건이 올바르지 않습니다.");
        }
    }

    private static int clamp(int value, int min, int max, int fallback) {
        return value == 0 ? fallback : Math.max(min, Math.min(max, value));
    }

    private static String trimOrNull(String value, int max) {
        if (value == null || value.isBlank()) {
            return null;
        }
        String t = value.strip();
        if (t.length() > max || t.chars().anyMatch(Character::isISOControl)) {
            throw ApiException.badRequest("INVALID_QUERY", "조건 값이 올바르지 않습니다.");
        }
        return t;
    }

    private static long parseId(Object raw) {
        if (raw instanceof Number n && n.longValue() > 0) {
            return n.longValue();
        }
        if (raw instanceof String s && DIGITS.matcher(s.strip()).matches() && Long.parseLong(s.strip()) > 0) {
            return Long.parseLong(s.strip());
        }
        throw ApiException.badRequest("INVALID_BATCH", "행 ID 가 올바르지 않습니다.");
    }

    // ================= 공통 =================

    private static void requireAction(AccessGrant grant, ProgramAction action) {
        if (!grant.canAll(PROGRAM_ID, ProgramAction.ACCESS, action)) {
            throw ApiException.forbidden("FORBIDDEN", "이 기능에 대한 권한이 없습니다.");
        }
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    private static ApiException versionConflict() {
        return ApiException.conflict("VERSION_CONFLICT", "다른 사용자가 먼저 수정했습니다. 새로 고침한 뒤 다시 시도하세요.");
    }

    private static AuditEntry audit(String action, long id, AccessGrant grant, String before, String after) {
        return new AuditEntry(action, id, grant.accountId(), grant.account().displayName(), before, after);
    }

    /** 감사 범위를 판별할 수 있도록 구역 코드만 기록한다. */
    private static void putDistrict(ObjectNode node, SheetRow row) {
        node.put("regionCode", row.regionCode());
        node.put("districtCode", row.districtCode());
    }

    private static String createdJson(SheetRow row) {
        ObjectNode node = JSON.createObjectNode().put("rowVersion", row.rowVersion());
        putDistrict(node, row);
        node.put("hasPhone", row.hasPhone());
        node.put("roundCount", row.rounds().size());
        return node.toString();
    }

    // ================= 응답 변환 =================

    /** API 응답용 맵. 연락처 원문·암호문·봉인본은 없다. 값이 없는 키는 null(JSON 에서는 생략될 수 있음). */
    public static Map<String, Object> view(SheetRow r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", Long.toString(r.id()));
        for (SheetField f : SheetField.values()) {
            Object v = r.value(f);
            m.put(f.key(), v instanceof Long l ? Long.toString(l) : v);
        }
        m.put("phoneLast4", r.phoneLast4());
        m.put("hasPhone", r.hasPhone());
        m.put("rounds", r.rounds().stream().map(x -> {
            Map<String, Object> rm = new LinkedHashMap<>();
            rm.put("code", x.code());
            rm.put("label", x.label());
            rm.put("callerUserId", x.callerUserId());
            rm.put("callerName", x.callerName());
            return rm;
        }).toList());
        m.put("rowVersion", r.rowVersion());
        m.put("deleted", r.deleted());
        m.put("createdAt", r.createdAt());
        m.put("updatedAt", r.updatedAt());
        return m;
    }
}
