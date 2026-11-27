package com.smoa.callingsheet;

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

import com.smoa.access.AccessGrant;
import com.smoa.callingsheet.CallingSheetRepository.Lookup;
import com.smoa.callingsheet.CallingSheetRepository.Stats;
import com.smoa.reference.ReferenceRepository;
import com.smoa.security.CurrentAccount;

/**
 * 콜링시트 API({@code /api/programs/callingSheet/**}). 접근 권한(access/read/write/export)은 보안 필터가 URL·메서드로 먼저 검사하고
 * (GET=read, POST/PUT/PATCH/DELETE=write, /export/**=export), 서비스가 한 번 더 확인한다. 구역 범위는 서비스·SQL 이 서버 계정 기준으로만 적용한다.
 * 본문은 Map 으로 받아 "필드가 없다 / null 이다 / 값이 있다"를 구분한다(부분 수정). 허용 목록 밖 필드는 400 이다.
 * 응답에는 연락처 원문·암호문이 없고 끝 네 자리와 보유 여부만 있다. 경로의 programId 는 상수이므로 ModuleController 의
 * {@code /{programId}/data/**} 미연결 응답과 충돌하지 않는다.
 */
@RestController
@RequestMapping("/api/programs/callingSheet")
public class CallingSheetController {

    public record BatchBody(List<Map<String, Object>> items) {
    }

    private final CallingSheetService service;
    private final CallingSheetXlsx xlsx;
    private final ReferenceRepository reference;

    public CallingSheetController(CallingSheetService service, CallingSheetXlsx xlsx, ReferenceRepository reference) {
        this.service = service;
        this.xlsx = xlsx;
        this.reference = reference;
    }

    @GetMapping("/options")
    public Map<String, Object> options() {
        return service.options(grant());
    }

    @GetMapping("/items")
    public Map<String, Object> list(@RequestParam Map<String, String> params) {
        CallingSheetService.SheetPage page = service.list(grant(), params);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("items", page.items().stream().map(CallingSheetService::view).toList());
        body.put("total", page.total());
        body.put("page", page.page());
        body.put("size", page.size());
        body.put("sort", page.sort());
        body.put("dir", page.desc() ? "desc" : "asc");
        return body;
    }

    /** 같은 필터 전체 집합의 정확한 집계(차트용). 페이지 크기·번호는 무시한다. */
    @GetMapping("/stats")
    public Map<String, Object> stats(@RequestParam Map<String, String> params) {
        Stats s = service.stats(grant(), params);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("total", s.total());
        body.put("unassigned", s.unassigned());
        body.put("manpik", s.manpik());
        body.put("byStatus", s.byStatus().stream().map(c -> keyCount(c.key(), c.count())).toList());
        body.put("byResult", s.byResult().stream().map(c -> keyCount(c.key(), c.count())).toList());
        body.put("byDistrict", s.byDistrict().stream().map(d -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("regionCode", d.regionCode());
            m.put("districtCode", d.districtCode());
            m.put("count", d.count());
            return m;
        }).toList());
        return body;
    }

    private static Map<String, Object> keyCount(String key, long count) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("key", key == null ? "" : key);
        m.put("count", count);
        return m;
    }

    @GetMapping("/items/{id:\\d{1,18}}")
    public Map<String, Object> get(@PathVariable long id,
            @RequestParam(defaultValue = "false") boolean includeDeleted) {
        return CallingSheetService.view(service.get(grant(), id, includeDeleted));
    }

    @PostMapping("/items")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> create(@RequestBody Map<String, Object> body) {
        return CallingSheetService.view(service.create(grant(), body));
    }

    @PatchMapping("/items/{id:\\d{1,18}}")
    public Map<String, Object> patch(@PathVariable long id, @RequestBody Map<String, Object> body) {
        return CallingSheetService.view(service.update(grant(), id, body));
    }

    @PutMapping("/items/{id:\\d{1,18}}")
    public Map<String, Object> put(@PathVariable long id, @RequestBody Map<String, Object> body) {
        return CallingSheetService.view(service.update(grant(), id, body));
    }

    /** 여러 행 원자적 수정. 하나라도 검증·버전 확인에 실패하면 전부 반영하지 않는다. */
    @PostMapping("/items/batch")
    public Map<String, Object> batch(@RequestBody BatchBody body) {
        List<Map<String, Object>> rows = service.batch(grant(), body.items()).stream().map(CallingSheetService::view)
                .toList();
        return Map.of("items", rows);
    }

    @DeleteMapping("/items/{id:\\d{1,18}}")
    public Map<String, Object> delete(@PathVariable long id, @RequestParam(required = false) Long rowVersion) {
        return CallingSheetService.view(service.delete(grant(), id, rowVersion));
    }

    @PostMapping("/items/{id:\\d{1,18}}/undelete")
    public Map<String, Object> undelete(@PathVariable long id, @RequestParam(required = false) Long rowVersion) {
        return CallingSheetService.view(service.undelete(grant(), id, rowVersion));
    }

    /** 연결할 대상자 선택지(범위 안, 최소 정보). 쓰기 권한 필요. */
    @GetMapping("/targets")
    public List<Map<String, Object>> targets(@RequestParam(required = false) String q,
            @RequestParam(defaultValue = "0") int limit) {
        return service.targets(grant(), q, limit).stream().map(CallingSheetController::lookup).toList();
    }

    @GetMapping("/members")
    public List<Map<String, Object>> members(@RequestParam(required = false) String q,
            @RequestParam(defaultValue = "0") int limit) {
        return service.members(grant(), q, limit).stream().map(CallingSheetController::lookup).toList();
    }

    private static Map<String, Object> lookup(Lookup l) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", l.id());
        m.put("name", l.name());
        m.put("code", l.code());
        m.put("regionCode", l.regionCode());
        m.put("districtCode", l.districtCode());
        return m;
    }

    /** 목록과 같은 필터 전체 행의 XLSX. 연락처는 끝 네 자리만. export 권한이 필요하다. */
    @GetMapping("/export/items.xlsx")
    public ResponseEntity<byte[]> export(@RequestParam Map<String, String> params) throws IOException {
        List<SheetRow> rows = service.exportRows(grant(), params);
        Map<String, String> names = new LinkedHashMap<>();
        reference.districts().forEach(d -> names.put(d.key().regionCode() + "\u0000" + d.key().districtCode(), d.name()));
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment().filename("callingSheet.xlsx").build().toString())
                .contentType(MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
                .body(xlsx.write(rows, names));
    }

    private static AccessGrant grant() {
        return CurrentAccount.require();
    }
}
