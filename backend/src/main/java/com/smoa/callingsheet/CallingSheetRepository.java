package com.smoa.callingsheet;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.LongFunction;
import java.util.function.Supplier;

import com.smoa.audit.AuditStamp;
import com.smoa.crypto.ContactVault.PhoneSecret;

/**
 * 콜링시트 저장소 계약. 구현은 local-memory 의 {@code MemoryCallingSheetRepository} 와 local/prod 의
 * {@code MyBatisCallingSheetRepository}(CallingSheetMapper/XML) 두 가지다.
 * <ul>
 *   <li>모든 조회·변경은 서비스가 계산한 {@link ScopeSpec} 를 받아 WHERE 에 반영한다. 범위 밖 행은 존재하지 않는 것과 같다.</li>
 *   <li>변경은 expectedVersion(ROW_VERSION)이 같을 때만 반영하고 다르면 {@link Outcome#CONFLICT}.</li>
 *   <li>변경 메서드는 서비스의 UnitOfWork 안에서 호출된다. 본표·회차·감사(CHGLOG)가 같이 커밋/롤백된다.</li>
 *   <li>PATCH 의미: Update.changes 에 키가 없으면 보존, 값이 null 이면 비움.</li>
 * </ul>
 */
public interface CallingSheetRepository {

    enum Outcome { OK, NOT_FOUND, CONFLICT }

    record Result(Outcome outcome, SheetRow row) {
        public static Result ok(SheetRow row) {
            return new Result(Outcome.OK, row);
        }

        public static Result of(Outcome outcome) {
            return new Result(outcome, null);
        }
    }

    record Page(List<SheetRow> rows, long total) {
    }

    record Count(String key, long count) {
    }

    record DistrictCount(String regionCode, String districtCode, long count) {
    }

    /** 같은 필터 전체 집합의 정확한 집계(페이지 크기와 무관). */
    record Stats(long total, long unassigned, long manpik, List<Count> byStatus, List<DistrictCount> byDistrict,
            List<Count> byResult) {
    }

    /** 선택지 한 건. id 는 내부 값(화면에 노출하지 않음), 표시는 name·code·지역·구역. */
    record Lookup(String id, String name, String code, String regionCode, String districtCode) {
    }

    /** 봉인 결과. phone 은 PHONE_ENC 용, sourceEnc 는 자유 문자열 속 전화번호 봉인 모음(JSON). */
    record Secrets(PhoneSecret phone, String sourceEnc) {
        public static final Secrets NONE = new Secrets(null, null);

        @Override
        public String toString() {
            return "Secrets[sealed]";
        }
    }

    record NewSheet(Map<SheetField, Object> values, List<RoundEntry> rounds) {
    }

    /**
     * 부분 수정. changes 의 키만 바꾼다. roundUpserts 는 코드 기준 추가/교체, roundRemovals 는 코드 삭제.
     * phoneChange 이면 phone(null=지움)을 PHONE_* 에 반영, sourceChange 이면 sourceEnc(null=지움)를 SOURCE_ENC 에 반영한다.
     */
    record Update(Map<SheetField, Object> changes, List<RoundEntry> roundUpserts, List<String> roundRemovals,
            boolean phoneChange, PhoneSecret phone, boolean sourceChange, String sourceEnc) {
    }

    /** 감사 한 줄(CHGLOG, TARGET_KIND=CALLSHEET). before/after 는 정제된 JSON(전화번호·이름·메모 값 없음). */
    record AuditEntry(String action, long sheetId, String actorId, String actorName, String beforeJson,
            String afterJson) {
    }

    /** 이 저장소가 다루는 자료실 ID(LIB_ID). 연락처 AAD 에 쓴다. */
    String libraryId();

    Page search(SheetQuery query, ScopeSpec scope);

    /** 내보내기: 같은 필터의 전체 행(최대 max). 페이지 조건은 무시한다. */
    List<SheetRow> findAll(SheetQuery query, ScopeSpec scope, int max);

    Stats stats(SheetQuery query, ScopeSpec scope);

    /** 범위 안 단건. includeDeleted=false 이면 삭제된 행은 없는 것으로 본다. */
    Optional<SheetRow> find(long id, ScopeSpec scope, boolean includeDeleted);

    /** DB 쓰기와 감사 순번을 같은 자료실 잠금 아래 실행한다. 호출 시 서비스 트랜잭션이 열려 있어야 한다. */
    default void lockForWrite() {
    }

    /** 새 행 + 회차를 만든다(ID 는 AUTO_INCREMENT). sealer 는 확정된 ID 로 봉인값을 만든다(null 이면 봉인 없음). */
    SheetRow insert(NewSheet sheet, LongFunction<Secrets> sealer, AuditStamp stamp);

    Result update(long id, Update update, long expectedVersion, ScopeSpec scope, AuditStamp stamp);

    Result setDeleted(long id, boolean deleted, long expectedVersion, ScopeSpec scope, AuditStamp stamp);

    /** 범위 안에서 쓰인 서로 다른 값(필터 선택지). field = callStatus | callResult. */
    List<String> distinctValues(String field, ScopeSpec scope, int limit);

    /** 연결할 대상자(TGT_ID)가 같은 자료실·삭제 안 됨·범위 안인가. */
    boolean targetVisible(long targetId, ScopeSpec scope);

    List<Lookup> targets(String q, ScopeSpec scope, int limit);

    List<Lookup> members(String q, ScopeSpec scope, int limit);

    boolean memberVisible(String employeeId, ScopeSpec scope);

    /** 메모리 저장소에서는 일괄 수정 동안 다른 쓰기가 끼어들지 않도록 잠근다. DB는 서비스 트랜잭션을 사용한다. */
    default <T> T executeBatch(Supplier<T> work) {
        return work.get();
    }

    void appendAudit(AuditEntry entry, AuditStamp stamp);
}
