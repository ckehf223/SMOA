package com.smoa.records;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.smoa.access.AccessGrant;
import com.smoa.permission.DistrictKey;
import com.smoa.records.RecordsService.ActivityFilter;
import com.smoa.records.RecordsService.HistoryFilter;
import com.smoa.records.RecordsService.Page;
import com.smoa.records.RecordsService.PersonFilter;
import com.smoa.reference.District;
import com.smoa.reference.ReferenceRepository;
import com.smoa.reference.Region;
import com.smoa.scope.ScopeEnforcer;
import com.smoa.security.CurrentAccount;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;

/**
 * records 모듈 API(people / activities / history / stages 프로그램). 접근 권한(프로그램·동작)은 보안 필터가
 * URL 패턴 {@code /api/programs/{programId}/**} 로 먼저 검사하고, 구역 범위는 서비스·SQL 이 서버 계정 기준으로 강제한다.
 * 대상자·활동 본문은 Map 으로 받아 "필드가 있는가/null 인가/값이 있는가"를 구분한다(부분 수정). 연락처 원문·암호문은 어떤 응답에도 없다.
 *
 * <p>목록: {@code /items} 는 호환용 배열(기본 2000행, 최대 5000행)이며 전체 건수를 {@code X-Total-Count} 헤더로 알린다.
 * 화면은 {@code /page} 를 쓴다: {@code {items,total,limit,offset}}, 총건수는 SQL COUNT, 이전/다음은 limit·offset.
 * 요약·집계는 페이지와 무관하게 같은 조건 전체에서 SQL 이 계산한다. 기존 행을 바꾸는 모든 요청(수정·단계·탈락·복귀·삭제·삭제 취소·활동 삭제)은
 * 조회한 {@code rowVersion} 이 필수다(없으면 400 ROW_VERSION_REQUIRED, 오래되면 409 VERSION_CONFLICT).
 */
@RestController
@RequestMapping("/api/programs")
public class RecordsController {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TOTAL_HEADER = "X-Total-Count";

    public record StageBody(@Size(max = 60) String stageId, @Size(max = 10) String effectiveDate,
            @Size(max = 8) String effectiveTime, @Size(max = 2000) String reason, Long rowVersion) {
    }

    public record LifecycleBody(@Size(max = 10) String effectiveDate, @Size(max = 2000) String reason, Long rowVersion) {
    }

    private final RecordsService service;
    private final PeopleXlsx xlsx;
    private final ReferenceRepository reference;
    private final ScopeEnforcer enforcer;

    public RecordsController(RecordsService service, PeopleXlsx xlsx, ReferenceRepository reference,
            ScopeEnforcer enforcer) {
        this.service = service;
        this.xlsx = xlsx;
        this.reference = reference;
        this.enforcer = enforcer;
    }

    // ---- people ----

    @GetMapping("/people/options")
    public Map<String, Object> options() {
        Map<String, Object> result = new LinkedHashMap<>(service.options());
        result.put("districts", visibleDistricts(grant()));
        return result;
    }

    @GetMapping({"/activities/options", "/history/options"})
    public Map<String, Object> districtOptions() {
        return Map.of("districts", visibleDistricts(grant()));
    }

    private List<Map<String, String>> visibleDistricts(AccessGrant grant) {
        // 선택 가능한 구역은 서버가 정한 범위(지역+구역)와 활성 여부로 좁힌 목록이다. 화면에는 지역명·구역명만 보이고 코드는 값으로만 쓴다.
        java.util.function.Predicate<DistrictKey> visible = enforcer.visibility(grant);
        Map<String, String> regionNames = new java.util.HashMap<>();
        for (Region r : reference.regions()) {
            regionNames.put(r.regionCode(), r.name());
        }
        List<Map<String, String>> districts = new java.util.ArrayList<>();
        for (District d : reference.districts()) {
            if (visible.test(d.key())) {
                Map<String, String> m = new LinkedHashMap<>();
                m.put("regionCode", d.key().regionCode());
                m.put("districtCode", d.key().districtCode());
                m.put("regionName", regionNames.getOrDefault(d.key().regionCode(), ""));
                m.put("name", d.name());
                m.put("districtName", d.name());
                districts.add(m);
            }
        }
        return districts;
    }

    /**
     * 인도자 선택지(조직원 명부, 서버 구역 범위로 좁힘, 이름·구성원 표기코드 검색, 최대 100행). 읽기 권한(people)만으로 호출된다.
     * 같은 이름이 여럿일 수 있으므로 {@code id}(불변 조직원 ID)로 고르게 하며, id 는 화면에 글자로 보이지 않는다.
     */
    @GetMapping("/people/introducers")
    public Map<String, Object> introducers(@RequestParam(required = false) String q,
            @RequestParam(defaultValue = "0") int limit) {
        RecordRepository.EmployeePage page = service.introducers(grant(), q, limit);
        Map<String, String> regionNames = new java.util.HashMap<>();
        for (Region r : reference.regions()) {
            regionNames.put(r.regionCode(), r.name());
        }
        List<Map<String, Object>> items = new java.util.ArrayList<>();
        for (RecordRepository.EmployeeOption e : page.items()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", e.id());
            m.put("name", e.name());
            m.put("code", e.code());
            String org = "";
            if (e.districtKey() != null) {
                String region = regionNames.getOrDefault(e.districtKey().regionCode(), "");
                String district = reference.findDistrict(e.districtKey()).map(District::name).orElse("");
                org = (region + " " + district).strip();
            }
            m.put("org", org);
            items.add(m);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("items", items);
        result.put("total", page.total());
        return result;
    }

    @GetMapping("/people/items")
    public ResponseEntity<List<Map<String, Object>>> listPeople(@RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode, @RequestParam(required = false) String stageId,
            @RequestParam(required = false) String status, @RequestParam(required = false) String q,
            @RequestParam(required = false) String phoneLast4, @RequestParam(required = false) String foundFrom,
            @RequestParam(required = false) String foundTo, @RequestParam(defaultValue = "false") boolean includeDeleted,
            @RequestParam(defaultValue = "0") int limit, @RequestParam(defaultValue = "0") int offset) {
        Page<Person> page = service.listPeople(grant(), new PersonFilter(regionCode, districtCode, stageId, status, q,
                includeDeleted, phoneLast4, foundFrom, foundTo, limit, offset));
        return withTotal(page, page.items().stream().map(RecordsController::view).toList());
    }

    @GetMapping("/people/page")
    public Map<String, Object> pagePeople(@RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode, @RequestParam(required = false) String stageId,
            @RequestParam(required = false) String status, @RequestParam(required = false) String q,
            @RequestParam(required = false) String phoneLast4, @RequestParam(required = false) String foundFrom,
            @RequestParam(required = false) String foundTo, @RequestParam(defaultValue = "false") boolean includeDeleted,
            @RequestParam(defaultValue = "0") int limit, @RequestParam(defaultValue = "0") int offset) {
        Page<Person> page = service.pagePeople(grant(), new PersonFilter(regionCode, districtCode, stageId, status, q,
                includeDeleted, phoneLast4, foundFrom, foundTo, limit, offset));
        return pageBody(page, page.items().stream().map(RecordsController::view).toList());
    }

    @GetMapping("/people/items/{id}")
    public Map<String, Object> getPerson(@PathVariable String id) {
        return view(service.getPerson(grant(), id));
    }

    @PostMapping("/people/items")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> createPerson(@RequestBody Map<String, Object> body) {
        return view(service.createPerson(grant(), body));
    }

    @PutMapping("/people/items/{id}")
    public Map<String, Object> updatePerson(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return view(service.updatePerson(grant(), id, body));
    }

    @PatchMapping("/people/items/{id}")
    public Map<String, Object> patchPerson(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return view(service.updatePerson(grant(), id, body));
    }

    /** 연락처 설정/지움. 응답에는 끝 네 자리와 보유 여부만 있다. */
    @PutMapping("/people/items/{id}/phone")
    public Map<String, Object> setPhone(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return view(service.setPhone(grant(), id, body));
    }

    @PostMapping("/people/items/{id}/stage")
    public Map<String, Object> changeStage(@PathVariable String id, @Valid @RequestBody StageBody body) {
        return view(service.changeStage(grant(), id, body.stageId(), body.effectiveDate(), body.effectiveTime(),
                body.reason(), body.rowVersion()));
    }

    @PostMapping("/people/items/{id}/dropout")
    public Map<String, Object> dropout(@PathVariable String id, @Valid @RequestBody LifecycleBody body) {
        return view(service.dropout(grant(), id, body.effectiveDate(), body.reason(), body.rowVersion()));
    }

    @PostMapping("/people/items/{id}/return")
    public Map<String, Object> restore(@PathVariable String id, @Valid @RequestBody LifecycleBody body) {
        return view(service.restore(grant(), id, body.effectiveDate(), body.reason(), body.rowVersion()));
    }

    /** rowVersion 은 필수다(쿼리 파라미터). 빠지면 400, 오래되면 409. */
    @DeleteMapping("/people/items/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deletePerson(@PathVariable String id, @RequestParam(required = false) Long rowVersion) {
        service.deletePerson(grant(), id, rowVersion);
    }

    @PostMapping("/people/items/{id}/undelete")
    public Map<String, Object> undelete(@PathVariable String id, @RequestParam(required = false) Long rowVersion) {
        return view(service.undelete(grant(), id, rowVersion));
    }

    /**
     * 대상자 목록 엑셀(.xlsx). 화면 조회와 같은 조건(q·단계·상태·구역·찾은 날짜·삭제 포함)·같은 구역 범위의 <b>전체 결과</b>를 내보낸다
     * (페이지 크기와 무관). 연락처는 끝 네 자리만.
     */
    @GetMapping("/people/export/items.xlsx")
    public ResponseEntity<byte[]> exportPeople(@RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode, @RequestParam(required = false) String stageId,
            @RequestParam(required = false) String status, @RequestParam(required = false) String q,
            @RequestParam(required = false) String phoneLast4, @RequestParam(required = false) String foundFrom,
            @RequestParam(required = false) String foundTo, @RequestParam(defaultValue = "false") boolean includeDeleted)
            throws IOException {
        byte[] bytes = xlsx.write(service.exportPeople(grant(), new PersonFilter(regionCode, districtCode, stageId, status,
                q, includeDeleted, phoneLast4, foundFrom, foundTo, 0, 0)));
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment().filename("people.xlsx").build().toString())
                .contentType(MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
                .body(bytes);
    }

    // ---- activities ----

    @GetMapping("/activities/items")
    public ResponseEntity<List<Map<String, Object>>> listActivities(@RequestParam(required = false) String personId,
            @RequestParam(required = false) Boolean standalone, @RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode, @RequestParam(required = false) String from,
            @RequestParam(required = false) String to, @RequestParam(defaultValue = "0") int limit,
            @RequestParam(defaultValue = "0") int offset) {
        Page<Activity> page = service.listActivities(grant(),
                new ActivityFilter(personId, standalone, regionCode, districtCode, from, to, limit, offset));
        return withTotal(page, page.items().stream().map(RecordsController::view).toList());
    }

    @GetMapping("/activities/page")
    public Map<String, Object> pageActivities(@RequestParam(required = false) String personId,
            @RequestParam(required = false) Boolean standalone, @RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode, @RequestParam(required = false) String from,
            @RequestParam(required = false) String to, @RequestParam(defaultValue = "0") int limit,
            @RequestParam(defaultValue = "0") int offset) {
        Page<Activity> page = service.pageActivities(grant(),
                new ActivityFilter(personId, standalone, regionCode, districtCode, from, to, limit, offset));
        return pageBody(page, page.items().stream().map(RecordsController::view).toList());
    }

    @GetMapping("/activities/items/{id}")
    public Map<String, Object> getActivity(@PathVariable String id) {
        return view(service.getActivity(grant(), id));
    }

    /** 화면 조회와 같은 조건(대상자·독립 여부·구역·기간)의 전체 집계(페이지와 무관). */
    @GetMapping("/activities/summary")
    public Map<String, Object> activitySummary(@RequestParam(required = false) String personId,
            @RequestParam(required = false) Boolean standalone, @RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode, @RequestParam(required = false) String from,
            @RequestParam(required = false) String to) {
        return service.activitySummary(grant(),
                new ActivityFilter(personId, standalone, regionCode, districtCode, from, to, 0, 0));
    }

    @PostMapping("/activities/items")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> createActivity(@RequestBody Map<String, Object> body) {
        return view(service.createActivity(grant(), body));
    }

    @PutMapping("/activities/items/{id}")
    public Map<String, Object> updateActivity(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return view(service.updateActivity(grant(), id, body));
    }

    @PatchMapping("/activities/items/{id}")
    public Map<String, Object> patchActivity(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return view(service.updateActivity(grant(), id, body));
    }

    /** rowVersion 은 필수다(쿼리 파라미터). */
    @DeleteMapping("/activities/items/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteActivity(@PathVariable String id, @RequestParam(required = false) Long rowVersion) {
        service.deleteActivity(grant(), id, rowVersion);
    }

    // ---- history / stages ----

    /** 호환용 배열(최신순, 기본 2000행). 전체 건수는 X-Total-Count. */
    @GetMapping("/history/items")
    public ResponseEntity<List<Map<String, Object>>> history(@RequestParam(required = false) String personId,
            @RequestParam(required = false) String from, @RequestParam(required = false) String to,
            @RequestParam(required = false) String kind, @RequestParam(defaultValue = "0") int limit,
            @RequestParam(defaultValue = "0") int offset) {
        Page<HistoryEntry> page = service.listHistory(grant(), new HistoryFilter(personId, from, to, kind, limit, offset));
        return withTotal(page, page.items().stream().map(RecordsController::view).toList());
    }

    @GetMapping("/history/page")
    public Map<String, Object> historyPage(@RequestParam(required = false) String personId,
            @RequestParam(required = false) String from, @RequestParam(required = false) String to,
            @RequestParam(required = false) String kind, @RequestParam(defaultValue = "0") int limit,
            @RequestParam(defaultValue = "0") int offset) {
        Page<HistoryEntry> page = service.pageHistory(grant(), new HistoryFilter(personId, from, to, kind, limit, offset));
        return pageBody(page, page.items().stream().map(RecordsController::view).toList());
    }

    @GetMapping("/stages/summary")
    public Map<String, Object> stageSummary(@RequestParam(required = false) String from,
            @RequestParam(required = false) String to, @RequestParam(required = false) String regionCode,
            @RequestParam(required = false) String districtCode) {
        return service.stageSummary(grant(), from, to, regionCode, districtCode);
    }

    private static <T> ResponseEntity<List<Map<String, Object>>> withTotal(Page<T> page, List<Map<String, Object>> body) {
        return ResponseEntity.ok().header(TOTAL_HEADER, Long.toString(page.total())).body(body);
    }

    private static <T> Map<String, Object> pageBody(Page<T> page, List<Map<String, Object>> items) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("items", items);
        m.put("total", page.total());
        m.put("limit", page.limit());
        m.put("offset", page.offset());
        return m;
    }

    // ---- 응답 모델(연락처 원문·암호문 없음) ----

    static Map<String, Object> view(Person p) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", p.id());
        for (PersonField field : PersonField.values()) {
            Object v = p.values().get(field);
            if (v == null || field == PersonField.DELETED) {
                continue;
            }
            m.put(field.key(), field == PersonField.CUSTOM ? parseJson(v.toString()) : v);
        }
        Object found = p.values().get(PersonField.FOUND_DATE);
        if (found != null) {
            m.put("registeredDate", found);      // 기존 화면 호환 별칭
        }
        m.put("phoneLast4", p.phoneLast4());
        m.put("hasPhone", p.hasPhone());
        m.put("deleted", p.deleted());
        m.put("rowVersion", p.rowVersion());
        m.put("createdAt", p.createdAt());
        m.put("updatedAt", p.updatedAt());
        return m;
    }

    static Map<String, Object> view(Activity a) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", a.id());
        m.put("personId", a.personId());
        m.put("standalone", a.standalone());
        for (ActivityField field : ActivityField.values()) {
            Object v = a.values().get(field);
            if (v != null && field != ActivityField.DELETED) {
                m.put(field.key(), v);
            }
        }
        m.put("rowVersion", a.rowVersion());
        m.put("createdAt", a.createdAt());
        m.put("updatedAt", a.updatedAt());
        return m;
    }

    static Map<String, Object> view(HistoryEntry h) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", h.id());
        m.put("kind", h.kind());
        m.put("personId", h.personId());
        if (h.districtKey() != null) {
            m.put("regionCode", h.districtKey().regionCode());
            m.put("districtCode", h.districtKey().districtCode());
        }
        m.put("type", h.type());
        m.put("fromValue", h.fromValue());
        m.put("toValue", h.toValue());
        m.put("effectiveDate", h.effectiveDate());
        m.put("effectiveAt", h.effectiveAt());
        m.put("timeUnknown", h.timeUnknown());
        m.put("baseline", h.baseline());
        m.put("reason", h.reason());
        m.put("actorName", h.actorName());
        m.put("recordedAt", h.recordedAt());
        m.put("action", h.action());
        return m;
    }

    private static Object parseJson(String text) {
        try {
            JsonNode node = JSON.readTree(text);
            return node == null ? null : node;
        } catch (Exception e) {
            return null;
        }
    }

    private static AccessGrant grant() {
        return CurrentAccount.require();
    }
}
