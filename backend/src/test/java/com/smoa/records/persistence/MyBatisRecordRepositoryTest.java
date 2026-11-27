package com.smoa.records.persistence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;

import com.smoa.config.LibraryContext;
import com.smoa.config.SmoaProperties;
import com.smoa.crypto.ContactVault.PhoneSecret;
import com.smoa.module.mapper.RecordsMapper;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.records.Activity;
import com.smoa.records.ActivityField;
import com.smoa.records.HistoryEntry;
import com.smoa.records.Person;
import com.smoa.records.PersonField;
import com.smoa.records.RecordRepository;
import com.smoa.records.RecordRepository.Outcome;
import com.smoa.records.RecordRepository.PeopleQuery;
import com.smoa.records.RecordRepository.PhoneUpdate;
import com.smoa.records.RecordRepository.WriteResult;

/**
 * DB 없이 Mockito 로 만든 RecordsMapper 위에서 어댑터 동작을 검증한다(SQL 자체는 MapperSqlContractTest 가 XML 로 검증).
 * 모든 값은 가상이다.
 */
class MyBatisRecordRepositoryTest {

    private RecordsMapper mapper;
    private MyBatisRecordRepository repository;

    @BeforeEach
    void setUp() {
        mapper = mock(RecordsMapper.class);
        repository = new MyBatisRecordRepository(mapper, new LibraryContext(new SmoaProperties(List.of(), null, null,
                new SmoaProperties.Storage("LIB-T"), null)));
    }

    private static Map<String, Object> personRow(Object id) {
        Map<String, Object> row = new HashMap<>();
        row.put("id", id);
        row.put("legacyId", "legacy-1");
        row.put("code", "C-1");
        row.put("name", "가상인");
        row.put("age", 30);
        row.put("foundDate", "2026-01-02");
        row.put("foundTime", "09:30:00");
        row.put("dateUnknown", 0L);
        row.put("regionCode", "R1");
        row.put("districtCode", "D1");
        row.put("stageId", "찾B");
        row.put("status", "active");
        row.put("custom", "{\"k\":\"v\"}");
        row.put("manpikDate", "2026-02-03");
        row.put("phoneLast4", "5678");
        row.put("hasPhone", 1L);
        row.put("rowVersion", java.math.BigInteger.valueOf(7));
        row.put("deleted", 0L);
        row.put("createdAt", "2026-01-02T00:00:00Z");
        row.put("updatedAt", "2026-01-03T00:00:00Z");
        return row;
    }

    @Test
    void 행을_도메인으로_바꾸면_원본_필드_Y_N_시각_버전이_보존된다() {
        Person p = MyBatisRecordRepository.toPerson(personRow(12L));
        assertThat(p.id()).isEqualTo("12");
        assertThat(p.legacyId()).isEqualTo("legacy-1");
        assertThat(p.name()).isEqualTo("가상인");
        assertThat(p.values().get(PersonField.AGE)).isEqualTo(30);
        assertThat(p.str(PersonField.FOUND_TIME)).isEqualTo("09:30");           // :00 초는 HH:mm 로
        assertThat(p.values().get(PersonField.DATE_UNKNOWN)).isEqualTo(false);
        assertThat(p.str(PersonField.MANPIK_DATE)).isEqualTo("2026-02-03");
        assertThat(p.districtKey()).isEqualTo(new DistrictKey("R1", "D1"));
        assertThat(p.rowVersion()).isEqualTo(7L);
        assertThat(p.hasPhone()).isTrue();
        assertThat(p.phoneLast4()).isEqualTo("5678");
        assertThat(p.deleted()).isFalse();
        assertThat(p.toString()).doesNotContain("가상인");
    }

    @Test
    void 구역이_없는_행은_districtKey_null_이다() {
        Map<String, Object> row = personRow(1L);
        row.remove("regionCode");
        row.remove("districtCode");
        assertThat(MyBatisRecordRepository.toPerson(row).districtKey()).isNull();
    }

    @Test
    void 독립_활동은_대상자_없이_NPE_없이_읽힌다() {
        Map<String, Object> row = new HashMap<>();
        row.put("id", 5L);
        row.put("date", "2026-03-01");
        row.put("startTime", "10:05:00");
        row.put("endTime", "11:35:30");
        row.put("minutes", 90);
        row.put("worker", "가상활동자");
        row.put("type", "방문");
        row.put("memo", "메모");
        row.put("sessionKey", "S-1");
        row.put("rowVersion", 1L);
        row.put("deleted", 0L);
        Activity a = MyBatisRecordRepository.toActivity(row);
        assertThat(a.standalone()).isTrue();
        assertThat(a.personId()).isNull();
        assertThat(a.districtKey()).isNull();
        assertThat(a.str(ActivityField.START_TIME)).isEqualTo("10:05");
        assertThat(a.str(ActivityField.END_TIME)).isEqualTo("11:35:30");
        assertThat(a.minutes()).isEqualTo(90);
        assertThat(a.str(ActivityField.SESSION_KEY)).isEqualTo("S-1");
        row.put("personId", 9L);
        assertThat(MyBatisRecordRepository.toActivity(row).standalone()).isFalse();
    }

    @Test
    void ORG_빈_배정은_SQL_없이_0행이고_ALL_은_scopeAll_이다() {
        PeopleQuery q = new PeopleQuery(null, null, null, null, null, false, null, null, null, 10, 0);
        assertThat(repository.searchPeople(q, DataScope.none())).isEmpty();
        assertThat(repository.findPerson("1", DataScope.none())).isEmpty();
        assertThat(repository.history(new RecordRepository.HistoryQuery(null, null, null, null, 10, 0), DataScope.none()).items()).isEmpty();
        assertThat(repository.countPeople(q, DataScope.none())).isZero();
        verify(mapper, never()).selectPeople(anyString(), anyMap(), anyBoolean(), anyList(), anyBoolean());
        verify(mapper, never()).countPeople(anyString(), anyMap(), anyBoolean(), anyList(), anyBoolean());
        verify(mapper, never()).countHistory(anyString(), anyMap(), anyBoolean(), anyList(), anyBoolean());

        when(mapper.selectPeople(eq("LIB-T"), anyMap(), eq(true), anyList(), anyBoolean())).thenReturn(List.of(personRow(1L)));
        assertThat(repository.searchPeople(q, DataScope.all())).hasSize(1);
        ArgumentCaptor<List<Map<String, String>>> districts = ArgumentCaptor.forClass(List.class);
        repository.searchPeople(q, DataScope.org(List.of(new DistrictKey("R2", "D1"), new DistrictKey("R1", "D2"))));
        verify(mapper).selectPeople(eq("LIB-T"), anyMap(), eq(false), districts.capture(), eq(false));
        assertThat(districts.getValue()).containsExactly(Map.of("regionCode", "R1", "districtCode", "D2"),
                Map.of("regionCode", "R2", "districtCode", "D1"));
    }

    @Test
    void 숫자가_아닌_ID_는_SQL_을_타지_않고_없는_것으로_처리된다() {
        assertThat(repository.findPerson("550e8400-e29b-41d4-a716-446655440000", DataScope.all())).isEmpty();
        assertThat(repository.findActivity("abc", DataScope.all())).isEmpty();
        assertThat(repository.updatePerson("x'; DROP", Map.of(), PhoneUpdate.NONE, 1, DataScope.all()).outcome())
                .isEqualTo(Outcome.NOT_FOUND);
        verify(mapper, never()).selectPersonById(anyString(), anyString(), anyBoolean(), anyList(), anyBoolean());
    }

    @SuppressWarnings("unchecked")
    @Test
    void 부분_수정은_지정한_필드만_매퍼에_넘기고_연락처는_바꾸지_않는다() {
        when(mapper.updatePerson(anyMap())).thenReturn(1);
        when(mapper.selectPersonById(eq("LIB-T"), eq("12"), eq(true), anyList(), anyBoolean())).thenReturn(personRow(12L));
        Map<PersonField, Object> changes = new java.util.EnumMap<>(PersonField.class);
        changes.put(PersonField.NAME, "새이름");
        changes.put(PersonField.NOTES, null);                    // 명시 null = 지움
        changes.put(PersonField.FOUND_DATE, "2026-01-05");
        WriteResult<Person> result = repository.updatePerson("12", changes, PhoneUpdate.NONE, 7, DataScope.all());
        assertThat(result.outcome()).isEqualTo(Outcome.OK);

        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);
        verify(mapper).updatePerson(captor.capture());
        Map<String, Object> row = captor.getValue();
        assertThat((Set<String>) row.get("changed")).containsExactlyInAnyOrder("name", "notes", "foundDate");
        assertThat(row.get("name")).isEqualTo("새이름");
        assertThat(row.get("notes")).isNull();
        assertThat(row.get("foundDate")).isEqualTo(LocalDate.of(2026, 1, 5));
        assertThat(row.get("phoneChange")).isEqualTo(false);
        assertThat(row.get("expectedVersion")).isEqualTo(7L);
        assertThat(row.get("libId")).isEqualTo("LIB-T");
        assertThat(row.get("scopeAll")).isEqualTo(true);
        assertThat(row).doesNotContainKeys("code", "gender", "stageId", "status", "legacyId");
        assertThat(row.get("sysAt")).isInstanceOf(LocalDateTime.class);
    }

    @Test
    void 영향_행이_0이면_존재하면_충돌_없으면_없음() {
        when(mapper.updatePerson(anyMap())).thenReturn(0);
        when(mapper.selectPersonById(anyString(), eq("3"), anyBoolean(), anyList(), anyBoolean())).thenReturn(personRow(3L));
        assertThat(repository.updatePerson("3", Map.of(PersonField.NAME, "x"), PhoneUpdate.NONE, 1, DataScope.all()).outcome())
                .isEqualTo(Outcome.CONFLICT);
        when(mapper.selectPersonById(anyString(), eq("4"), anyBoolean(), anyList(), anyBoolean())).thenReturn(null);
        assertThat(repository.updatePerson("4", Map.of(PersonField.NAME, "x"), PhoneUpdate.NONE, 1, DataScope.all()).outcome())
                .isEqualTo(Outcome.NOT_FOUND);
    }

    @SuppressWarnings("unchecked")
    @Test
    void 연락처_변경은_봉투와_끝네자리만_매퍼에_전달한다() {
        when(mapper.updatePerson(anyMap())).thenReturn(1);
        when(mapper.selectPersonById(anyString(), anyString(), anyBoolean(), anyList(), anyBoolean())).thenReturn(personRow(1L));
        repository.updatePerson("1", Map.of(), PhoneUpdate.set(new PhoneSecret("{\"version\":1}", "9999", "v1")), 7, DataScope.all());
        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);
        verify(mapper).updatePerson(captor.capture());
        assertThat(captor.getValue()).containsEntry("phoneChange", true).containsEntry("phoneEnc", "{\"version\":1}")
                .containsEntry("phoneLast4", "9999").containsEntry("phoneKeyVer", "v1");
        assertThat((Set<String>) captor.getValue().get("changed")).isEmpty();
    }

    @SuppressWarnings("unchecked")
    @Test
    void 새_대상자는_AUTO_INCREMENT_키를_받고_UUID_를_PK_로_쓰지_않으며_원본필드를_모두_전달한다() {
        when(mapper.insertPerson(anyMap())).thenAnswer(inv -> {
            ((Map<String, Object>) inv.getArgument(0)).put("id", 321L);
            return 1;
        });
        when(mapper.selectPersonById(anyString(), eq("321"), anyBoolean(), anyList(), anyBoolean())).thenReturn(personRow(321L));
        Map<PersonField, Object> values = new java.util.EnumMap<>(PersonField.class);
        values.put(PersonField.NAME, "가상인");
        values.put(PersonField.STAGE, "찾B");
        values.put(PersonField.TOOL, "도구");
        Person saved = repository.insertPerson(new Person(null, null, values, null, false, 0, null, null));
        assertThat(saved.id()).isEqualTo("321");
        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);
        verify(mapper).insertPerson(captor.capture());
        for (PersonField f : PersonField.values()) {
            assertThat(captor.getValue()).containsKey(f.key());
        }
        assertThat(captor.getValue().get("tool")).isEqualTo("도구");
        assertThat(captor.getValue()).doesNotContainKeys("phoneEnc", "phoneLast4");
    }

    @Test
    void 단계_이력은_한국_업무시각_분단위_00초와_UTC_감사시각을_따로_기록한다() {
        when(mapper.selectNextStageSeq("12")).thenReturn(3L);
        HistoryEntry entry = new HistoryEntry(null, HistoryEntry.KIND_STAGE, "12", null, HistoryEntry.STAGE_CHANGED, "찾B", "콜링",
                "2026-01-05", "2026-01-05T09:30", false, false, "사유", "acct-1", "가상관리자", null, null, null, null);
        repository.appendHistory(entry, null, null);
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);
        verify(mapper).insertStageLog(captor.capture());
        Map<String, Object> row = captor.getValue();
        assertThat(row.get("seq")).isEqualTo(3L);
        assertThat(row.get("effectiveAt")).isEqualTo(LocalDateTime.of(2026, 1, 5, 9, 30, 0));   // Asia/Seoul 업무 시각 그대로, 초 :00
        assertThat(row.get("recordedAt")).isInstanceOf(LocalDateTime.class);                       // UTC 감사 시각
        assertThat(((LocalDateTime) row.get("recordedAt")).getNano()).isZero();
        assertThat(row.get("timeUnknown")).isEqualTo(false);
        assertThat(row).containsEntry("libId", "LIB-T").containsEntry("personId", "12").containsEntry("actorName", "가상관리자");

        // 시각 미상(날짜만)은 00:00:00 으로 저장하고 timeUnknown 으로 구분한다
        HistoryEntry dateOnly = new HistoryEntry(null, HistoryEntry.KIND_STAGE, "12", null, HistoryEntry.STAGE_CHANGED, "콜링", "만픽",
                "2026-01-06", null, true, false, null, "a", "n", null, null, null, null);
        repository.appendHistory(dateOnly, null, null);
        verify(mapper, org.mockito.Mockito.times(2)).insertStageLog(captor.capture());
        assertThat(captor.getValue().get("effectiveAt")).isEqualTo(LocalDateTime.of(2026, 1, 6, 0, 0, 0));
        assertThat(captor.getValue().get("timeUnknown")).isEqualTo(true);
    }

    @SuppressWarnings("unchecked")
    @Test
    void CHGLOG_는_자료실_행을_잠근_뒤_이전_해시를_이어_붙인다() {
        when(mapper.selectLastChangeLog("LIB-T")).thenReturn(Map.of("seq", 40L, "hash", "a".repeat(64)));
        HistoryEntry entry = new HistoryEntry(null, HistoryEntry.KIND_CHANGE, "12", null, HistoryEntry.UPDATED, null, null, "2026-01-05",
                null, false, false, null, "acct-1", "가상관리자", null, "person.update", "TGMSTR", "12");
        repository.appendHistory(entry, "{\"name\":\"가\"}", "{\"name\":\"나\"}");
        InOrder order = inOrder(mapper);
        order.verify(mapper).lockLibrary("LIB-T");
        order.verify(mapper).selectLastChangeLog("LIB-T");
        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);
        order.verify(mapper).insertChangeLog(captor.capture());
        Map<String, Object> row = captor.getValue();
        assertThat(row.get("seq")).isEqualTo(41L);
        assertThat(row.get("prevHash")).isEqualTo("a".repeat(64));
        assertThat((String) row.get("entryHash")).matches("[0-9a-f]{64}").isNotEqualTo("a".repeat(64));
        assertThat(row).containsEntry("action", "person.update").containsEntry("targetKind", "TGMSTR").containsEntry("targetId", "12");

        // 해시는 입력이 하나라도 바뀌면 달라진다(결정적)
        String h1 = MyBatisRecordRepository.chainHash("p", 1, "a", "k", "t", "u", LocalDateTime.of(2026, 1, 1, 0, 0), "b", "c");
        assertThat(MyBatisRecordRepository.chainHash("p", 1, "a", "k", "t", "u", LocalDateTime.of(2026, 1, 1, 0, 0), "b", "c")).isEqualTo(h1);
        assertThat(MyBatisRecordRepository.chainHash("p", 1, "a", "k", "t", "u", LocalDateTime.of(2026, 1, 1, 0, 0), "b", "d")).isNotEqualTo(h1);
    }

    @Test
    void 첫_CHGLOG_는_순번_1_이고_이전_해시가_없다() {
        when(mapper.selectLastChangeLog("LIB-T")).thenReturn(null);
        HistoryEntry entry = new HistoryEntry(null, HistoryEntry.KIND_CHANGE, null, null, HistoryEntry.CREATED, null, null, null, null,
                false, false, null, "a", "n", null, "person.create", null, null);
        repository.appendHistory(entry, null, null);
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);
        verify(mapper).insertChangeLog(captor.capture());
        assertThat(captor.getValue().get("seq")).isEqualTo(1L);
        assertThat(captor.getValue().get("prevHash")).isNull();
    }

    @Test
    void 이력_한_쪽은_UNION_행에서_종류별_유형을_만들고_총건수는_COUNT_에서_온다() {
        Map<String, Object> stage = new HashMap<>();
        stage.put("kind", "STAGE");
        stage.put("id", 1L);
        stage.put("personId", 12L);
        stage.put("regionCode", "R1");
        stage.put("districtCode", "D1");
        stage.put("toValue", "찾B");
        stage.put("effectiveAt", "2026-01-01T00:00:00");
        stage.put("recordedAt", "2026-01-01T01:00:00Z");
        stage.put("baseline", 1L);
        stage.put("timeUnknown", 1L);
        Map<String, Object> status = new HashMap<>();
        status.put("kind", "STATUS");
        status.put("id", 2L);
        status.put("personId", 12L);
        status.put("toValue", "dropped");
        status.put("effectiveAt", "2026-02-01T00:00:00");
        status.put("recordedAt", "2026-02-01T01:00:00Z");
        Map<String, Object> change = new HashMap<>();
        change.put("kind", "CHANGE");
        change.put("id", 3L);
        change.put("personId", 12L);
        change.put("action", "person.update");
        change.put("targetKind", "TGMSTR");
        change.put("targetId", "12");
        change.put("recordedAt", "2026-01-15T03:00:00Z");
        when(mapper.countHistory(anyString(), anyMap(), anyBoolean(), anyList(), anyBoolean())).thenReturn(9001L);
        when(mapper.selectHistory(anyString(), anyMap(), anyBoolean(), anyList(), anyBoolean())).thenReturn(List.of(stage, status, change));
        RecordRepository.HistoryPage page = repository.history(new RecordRepository.HistoryQuery("12", null, null, null, 3, 6), DataScope.all());
        assertThat(page.total()).isEqualTo(9001L);                  // 페이지(3행)와 무관한 전체 건수
        List<HistoryEntry> list = page.items();
        assertThat(list).extracting(HistoryEntry::type).containsExactly(HistoryEntry.STAGE_BASELINE, HistoryEntry.DROPPED, HistoryEntry.UPDATED);
        assertThat(list.get(0).baseline()).isTrue();
        assertThat(list.get(0).effectiveDate()).isEqualTo("2026-01-01");
        assertThat(list.get(0).recordedAt()).endsWith("Z");                      // 감사 시각 UTC
        assertThat(list.get(1).effectiveAt()).isEqualTo("2026-02-01T00:00:00");  // 업무 시각(Z 없음)
        assertThat(list.get(2).kind()).isEqualTo(HistoryEntry.KIND_CHANGE);
        ArgumentCaptor<Map<String, Object>> f = ArgumentCaptor.forClass(Map.class);
        verify(mapper).selectHistory(eq("LIB-T"), f.capture(), eq(true), anyList(), eq(false));
        assertThat(f.getValue()).containsEntry("limit", 3).containsEntry("offset", 6).containsEntry("personId", "12");
    }

    @Test
    void 단계_이동_집계는_SQL_그룹_결과를_그대로_쓰고_활동_요약은_SQL_합계다() {
        Map<String, Object> g = new HashMap<>();
        g.put("fromValue", "찾B");
        g.put("toValue", "콜링");
        g.put("cnt", 2500L);                                       // 2000 을 넘는 전체 집계
        when(mapper.selectStageTransitions(anyString(), anyMap(), anyBoolean(), anyList(), anyBoolean())).thenReturn(List.of(g));
        assertThat(repository.stageTransitions(new RecordRepository.StageQuery("2026-01-01", "2026-12-31", null, null), DataScope.all()))
                .containsEntry("찾B → 콜링", 2500L);
        Map<String, Object> sum = new HashMap<>();
        sum.put("personCount", java.math.BigDecimal.valueOf(2100));
        sum.put("personMinutes", java.math.BigDecimal.valueOf(9000));
        sum.put("standaloneCount", java.math.BigDecimal.valueOf(2253));
        sum.put("standaloneMinutes", java.math.BigDecimal.valueOf(100));
        when(mapper.summarizeActivities(anyString(), anyMap(), anyBoolean(), anyList(), anyBoolean())).thenReturn(sum);
        RecordRepository.ActivityTotals t = repository.summarizeActivities(
                new RecordRepository.ActivityQuery(null, null, null, null, null, null, 1, 0), DataScope.all());
        assertThat(t.total()).isEqualTo(4353L);
        assertThat(t.standaloneCount()).isEqualTo(2253L);
    }

    @Test
    void ALL_활성구역_범위는_구역_미지정_행도_포함하도록_unassigned_로_전달된다() {
        when(mapper.countPeople(anyString(), anyMap(), anyBoolean(), anyList(), anyBoolean())).thenReturn(0L);
        PeopleQuery q = new PeopleQuery(null, null, null, null, null, false, null, null, null, 10, 0);
        repository.countPeople(q, DataScope.allListed(List.of(new DistrictKey("R1", "D1"))));
        verify(mapper).countPeople(eq("LIB-T"), anyMap(), eq(false), anyList(), eq(true));
    }

    @Test
    void 공통코드는_그룹별_항목_순서와_활성여부를_읽는다() {
        Map<String, Object> a = Map.of("groupCode", "STAGE", "itemCode", "찾B", "itemName", "찾 B", "sortOrder", 0, "active", 1L);
        Map<String, Object> b = Map.of("groupCode", "STAGE", "itemCode", "옛단계", "itemName", "옛 단계", "sortOrder", 9, "active", 0L);
        when(mapper.selectCodeItems("LIB-T")).thenReturn(List.of(a, b));
        RecordRepository.CodeItem first = repository.codes().get("STAGE").get(0);
        assertThat(first.value()).isEqualTo("찾B");
        assertThat(first.active()).isTrue();
        assertThat(repository.codes().get("STAGE").get(1).active()).isFalse();
    }
}
