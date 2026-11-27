# 업무 모듈 연결 가이드 (Mapper XML ↔ Service ↔ 화면)

작성: 2026-11-26 (1단계: identity / reference / records 실제 DB 연결). 이 문서에는 비밀 값·실명·실제 자료가 없다.
다음 단계에서 미이식 모듈을 같은 방식으로 이어서 이식한다. **이번 단계는 전체 완료가 아니다**(현황: `docs/FUNCTION_PARITY.md`).

## 1. 계층과 파일 위치

```
frontend/assets/modules/<module>.js          화면(HTML·CSS·JS, 한국어, 모바일)
  → RestController  (예: records/RecordsController)   권한(프로그램·동작)은 보안 필터가 URL 로 먼저 검사
  → Service         (예: records/RecordsService)       구역 범위·입력 검증·트랜잭션(UnitOfWork)
  → Repository 어댑터 (예: records/persistence/MyBatisRecordRepository, local-memory 는 records/memory/...)
  → Mapper 인터페이스 (module/mapper/RecordsMapper.java)
  → Mapper XML      (resources/mapper/module/RecordsMapper.xml)  ← SQL 은 여기에만 있다
  → MariaDB (smoa DB, 26개 테이블)
```

- 프로파일: `local-memory`(가상 자료, DB 없음) / `local`(IntelliJ + SSH 터널, log4jdbc) / `prod`(일반 드라이버). 반드시 하나만 지정.
- 어댑터에는 SQL 이 없다. 행 Map ↔ 도메인 변환, 구역 범위 → SQL 파라미터, 감사 값(SYS_*) 채우기만 한다.
- `MapperContractVerifier`(local/prod 기동 시)는 **실제 연결된 Mapper 만** 검사한다: ProgramMapper / PackageMapper / AccountMapper / ReferenceMapper / RecordsMapper.
  미이식 모듈 Mapper(Analytics, Socialing, Calling, Imports, Goals, Organization)는 검사하지 않으며 XML 에 statement 를 넣지 않는다(가짜 SQL·`SELECT 1`·빈 목록 반환 금지). 해당 프로그램은 `501 MODULE_NOT_CONNECTED`.

## 2. 새 모듈을 연결하는 순서

1. `ModulesConfig` 의 `connectedProgramIds` 는 **실제로 DB 까지 연결된 프로그램만** 넣는다.
2. Mapper 인터페이스 메서드마다 같은 id 의 XML statement 를 쓴다. 값은 모두 `#{}` 바인딩, 표 별칭 치환(`${a}`)만 예외(코드가 고정한 상수).
3. **모든 업무 SQL 에 `LIB_ID = #{libId}`**(자료실, 서버 설정 `SMOA_LIBRARY_ID`)와 **구역 범위 조건**을 둔다(3절).
4. 쓰기는 Service 에서 `UnitOfWork.execute(...)` 한 번으로 묶는다(현재 행 + 이력 + CHGLOG).
5. `MapperContractVerifier.CONTRACTS` 에 새 Mapper 를 추가하고(`PENDING_MODULES` 에서 제거) `MapperSqlContractTest` 에 SQL 렌더링 검사를 추가한다.
6. 가상 자료 테스트(local-memory, Mockito, BoundSql 렌더링)를 작성한다. 실제 DB 로 테스트하지 않는다.

## 3. 구역 범위 규칙 (복합키 `(ORG_MSTR_CODE, ORG_CODE)`)

- 서버가 `AccessGrant.scope()` 에서 정한다. 요청의 구역·계정·패키지 값은 범위를 넓히지 못한다.
- SQL 조각 `scopeCond`(RecordsMapper.xml):
  - ALL → `1 = 1` (구역 미지정 행 포함)
  - ORG 이고 배정 목록이 비어 있음/null → `1 = 0` (0행)
  - ORG → `((지역 = ? AND 구역 = ?) OR (...))` 한 덩어리가 **괄호로 감싸여** `AND` 로 이어진다 (OR 가 LIB_ID 조건을 우회하지 못함).
  - 구역이 없는(NULL) 행은 ALL 에서만 보인다.
- 서비스에서 한 번 더 `ScopeEnforcer.visible/visibility`: 비활성·미등록 구역은 ALL 이어도 숨김, 구역 NULL 은 ALL 만, 범위 밖 단건은 404(존재 여부를 알리지 않음), 범위 밖 구역으로의 생성·이동은 403.
- 이력(TGSTGLOG/TGSTATLOG)은 **대상자의 현재 구역**으로 범위를 판정한다(JOIN TGMSTR). CHGLOG 는 대상자/활동에 연결될 때만 범위가 판정되고, ORG 범위에서는 연결되지 않은 항목이 보이지 않는다.

## 4. records API (RecordsController, `/api/programs/{people|activities|history|stages}/…`)

### 대상자 `/api/programs/people`
| 메서드·경로 | 설명 |
|---|---|
| GET `/options` | 단계(공통코드 STAGE 그룹, `stages`=활성 코드, `stageItems`=이름·활성), 상태(`active`/`dropped`), 그 밖 공통코드 그룹(`codes`), 범위 안 활성 구역(`districts`) |
| GET `/items?q&regionCode&districtCode&stageId&status&phoneLast4&foundFrom&foundTo&includeDeleted&limit&offset` | 목록. 기본 limit 2000(최대 5000). `phoneLast4` 는 숫자 4자리만 |
| GET `/items/{id}` | 단건. `id` 는 TGT_ID(AUTO_INCREMENT) 숫자 문자열 |
| POST `/items` | 등록. 필수: `name`, `regionCode`+`districtCode`, `stageId`. 선택: 아래 모든 필드 + `phone` |
| PUT·PATCH `/items/{id}` | **부분 수정**(아래 규칙). `rowVersion` 필수 |
| PUT `/items/{id}/phone` | 연락처 설정/지움. 본문 `{ "phone": "...", "rowVersion": N }`, `phone` 이 null/빈 값이면 지움 |
| POST `/items/{id}/stage` · `/dropout` · `/return` | 단계 이동(`stageId`, `effectiveDate`, `effectiveTime`(선택, 한국 시각), `reason`, `rowVersion`(선택)), 탈락·복귀(`effectiveDate`, `reason`, `rowVersion`(선택)) |
| DELETE `/items/{id}?rowVersion=` · POST `/items/{id}/undelete` | 소프트 삭제(DEL_IND). 원래 상태 코드는 바뀌지 않는다 |
| GET `/export/items.xlsx` | 엑셀(권한 export). 원본 필드 전체 + 연락처는 끝 네 자리만 |

**필드(JSON 키 ↔ TGMSTR 컬럼)**: `code`(TGT_CODE) `name`(TGT_NAME_HAN) `gender`(SEX_CODE) `age`(AGE 0~120) `ageAsOf`(AGE_BASE_DATE) `foundDate`(FOUND_DATE, 미래 불가; 기존 이름 `registeredDate` 도 같은 값) `foundTime`(FOUND_TIME) `dateUnknown`(DATE_UNKNOWN_IND) `classification1/2`(CLASS1/2_CODE) `place` `tool` `residence` `teacher` `reason` `worker`(WORKER_NAME) `introducerId`(EMPL_ID, 조직원 명부 존재 검증) `introducerCode` `introducerName` `introducerOrg`(INTRO_*) `regionCode`+`districtCode`(ORG_MSTR_CODE+ORG_CODE) `className`(BAN_CODE) `employment`(JOB_CODE) `stageId`(STAGE_CODE) `status`(STATUS_CODE) `appointment`(APPOINTMENT_TEXT) `notes` `custom`(CUSTOM_JSON, 객체) `manpikDate` `findADate` `habBDate` `habADate` `youngTtaDate` `bokshinDate` `cardReceivedDate` `centerRegisteredDate` · 읽기 전용: `id` `phoneLast4` `hasPhone` `deleted` `rowVersion` `createdAt`(UTC) `updatedAt`(UTC).

**수정 규칙 (빈값 vs 미지정)**
- 본문에 **키가 없으면** 그 필드는 그대로다(다른 컬럼·`SOURCE_ENC`·`LEGACY_ID`·연락처도 보존).
- 키가 있고 값이 **`null`** 이거나 **빈 문자열/공백**이면 그 필드를 **지운다**(NULL). 필수 필드(`name`)는 400. `dateUnknown` 이 null 이면 false.
- 값이 현재와 같으면 변경 없음(버전·이력을 올리지 않는다).
- `stageId`·`status`·`deleted`·`phone` 은 일반 수정으로 바꿀 수 없다(400). 허용 목록 밖의 키도 400.
- 구역은 `regionCode` 와 `districtCode` 를 **함께** 보낼 때만 이동한다. 범위 밖 구역으로의 이동은 403.
- **동시 수정**: `rowVersion`(조회 때 받은 값)이 현재와 다르면 `409 VERSION_CONFLICT`, 없으면 `400 ROW_VERSION_REQUIRED`. 성공하면 +1.

**중복 허용**: 이름·연락처·`code`(TGT_CODE)·`LEGACY_ID` 는 중복을 허용한다(별개 대상자). 식별번호를 비워도 자동으로 만들지 않는다. 식별번호 형식은 영문·숫자·-·_ 3~60자이며 네 자리 숫자만은 불가(연락처 끝 네 자리와의 혼동 방지).

### 활동 `/api/programs/activities`
GET `/items?personId&standalone&regionCode&districtCode&from&to` · GET `/summary?from&to`(대상자 활동/독립 활동 건수·분 구분) · POST/PUT·PATCH/DELETE `/items[/{id}]`.
필드: `date`(필수) `startTime` `endTime` `minutes`(없으면 시작~종료로 계산) `type`(ACT_KIND_NAME, 필수) `code` `worker` `workerId` `workerCode` `className` `classification2` `place` `sessionKey` `memo` · `personId`(생성 때만; 없으면 **독립 활동**, 이때 `regionCode`+`districtCode` 필수).
대상자 활동의 구역은 대상자의 구역이고, 독립 활동의 생성·수정·삭제도 구역 범위 안이어야 한다(범위 밖 생성 403 / 조회·수정·삭제 404). 구역이 NULL 인 활동은 ALL 에서만 보인다.

### 이력 `/api/programs/history/items?personId=` · 단계 분석 `/api/programs/stages/summary?from&to`
항목: `kind`(STAGE=TGSTGLOG / STATUS=TGSTATLOG / CHANGE=CHGLOG), `type`(STAGE_BASELINE, STAGE_CHANGED, DROPPED, RESTORED, CREATED, UPDATED, DELETED, UNDELETED, PHONE_CHANGED, ACTIVITY_CHANGED, 또는 이관 원본 동작명), `effectiveAt`/`effectiveDate`(한국 Asia/Seoul 업무 시각, 분 단위는 `:00` 초; `timeUnknown` 이면 `T00:00:00`), `recordedAt`(UTC, 끝 `Z`).
단계/상태 변경과 중복되는 CHGLOG 감사 항목은 목록에서 숨기고 단계/상태 로그만 보인다.

## 5. 쓰기 트랜잭션과 이력

- 대상자 생성: TGMSTR 행(AUTO_INCREMENT) → (연락처가 있으면 확정된 TGT_ID 로 봉인해 `attachInitialPhone`) → 단계 기준 행(TGSTGLOG, BASELINE=Y) → CHGLOG `person.create`. 한 `UnitOfWork`.
- 단계 이동: 현재 행 UPDATE(`ROW_VERSION` 조건) → TGSTGLOG → CHGLOG(`person.stage`). 탈락/복귀: TGSTATLOG + CHGLOG. 소프트 삭제: DEL_IND + CHGLOG. 활동: ACTMSTR + CHGLOG(`activity.*`).
- 하나라도 실패하면 예외가 전파되어 `TransactionTemplate` 이 전체를 롤백한다(`PersistenceWiringTest` 가 호출이 모두 한 `UnitOfWork` 안인지 확인).
- **CHGLOG 해시 체인**: 자료실 행(LIBMSTR)을 `SELECT … FOR UPDATE` 로 잠가 순번을 직렬화하고, `PREV_HASH` = 마지막 항목의 `ENTRY_HASH`, `ENTRY_HASH` = SHA-256(`이전해시|순번|동작|대상종류|대상ID|처리자|UTC시각|전|후`). 이관된 기존 항목의 해시 알고리즘과는 별개로 새 항목만 이 규칙을 쓴다.
- 변경 이력 JSON 에는 **변경된 필드만** 들어가고, 문자열 안 연락처 형태 숫자열은 `[연락처 비공개]` 로 가린다. 연락처 변경은 `{"phone":"changed"}` 사실만 남긴다.
- 감사 SYS_*: `SYS_*_ID`=계정 ID(요청 밖은 `SYSTEM`), `SYS_*_IP`=요청 IP, `SYS_*_DTTM`=**UTC**(서버 작성). 업무 시각(적용일시)은 Asia/Seoul 이다. 둘을 섞지 않는다.

## 6. 연락처 암호화

- 키: 환경 변수 `SMOA_CONTACT_KEY_FILE` 이 가리키는 **정확히 32바이트 파일**(내용·값은 로그·응답·DB 에 없다). 설정했는데 읽을 수 없으면 기동 실패. 설정하지 않으면 기동은 되지만 연락처 저장은 `503 CONTACT_KEY_UNAVAILABLE`(끝 네 자리 조회는 가능). local-memory 는 파일이 없으면 프로세스 임의 키.
- 봉투: `scripts/migrate-workspace.cjs` 의 `seal()` 과 동일 — 평문은 `JSON.stringify(phone)`(따옴표 포함 JSON 문자열), `{version:1,keyVersion:'v1',aad,iv(12),tag(16),body}`(base64, 키 순서 고정). Java 가 같은 키·iv·AAD 로 만든 봉투는 Node 봉투와 문자열까지 같다(`ContactCryptoTest`, 합성 fixture `src/test/resources/crypto/`).
- AAD: 이관 행 `SMOA:v1:<LIB_ID>:TGMSTR:<SOURCE_ID>:PHONE_ENC`(SOURCE_ID = MIGMAP `ENTITY_KIND=TGMSTR`, `TARGET_ID`=TGT_ID 에 대응하는 원본 ID), 웹에서 만든(또는 다시 봉인한) 행 `SMOA:v1:<LIB_ID>:TGMSTR:db:<TGT_ID>:PHONE_ENC`. 열 때는 **봉투가 주장하는 AAD 를 믿지 않고** 레코드로 계산한 기대 AAD 목록과 정확히 같을 때만 GCM 인증한다.
- `SOURCE_ENC`(원본 전체 암호문)는 일반 업무 조회·수정에서 복호화하지 않고 **그대로 보존**한다. 일반 API 로 원본 전체를 덤프하는 경로는 없다.

## 7. 로그

- `jdbc.sqltiming`(local)은 바인딩된 SQL 을 그대로 출력하되 `RedactingSpyLogDelegator`(`log4jdbc.spylogdelegator.name`)가 연락처 암호문/끝 네 자리 비교/비밀번호 해시/`SOURCE_ENC` 가 들어가는 INSERT·UPDATE·비교 조건의 **문자열 리터럴만** `'[REDACTED]'` 로 바꾼다. 일반 SELECT 의 바인딩·들여쓰기·공백·실행 시간은 유지된다(`log4jdbc.trim.sql=false` 등 기존 플래그 불변).
- 화면 콘솔·오류·이력에 연락처 원문을 남기지 않는다(원문 자체가 응답에 없다).

## 8. 소프트 삭제·추가 컬럼 — `db/migrations/001-web-persistence.sql`

적용 전에는 대상자/활동 쿼리가 `DEL_IND` 컬럼을 참조하므로 **서버가 동작하지 않는다.** 적용 순서는 `docs/DB_CONNECTION_RUNBOOK.md` 6절.
- `TGMSTR.DEL_IND`, `ACTMSTR.DEL_IND`, `ACTMSTR.ROW_VERSION`, `PGMMSTR.MODULE_ID`, `PGMMSTR.CATEGORY_CODE`(NULL 이면 서버 기본 카탈로그 = 모듈 `defaultProgramIds`). `db/smoa-schema.sql` 도 같은 컬럼으로 동기화했다.

## 9. 아직 하지 않은 것 (이 단계의 한계)

- 실제 smoa DB 에서의 실행·성능·권한 검증(Codex 후속). 지금까지의 검증은 Mockito / MyBatis BoundSql 렌더링 / local-memory 뿐이다.
- 미이식 모듈 전부(분석·소셜링·콜링·엑셀·일보·목표·조직/명부/공통코드 관리·지역활동·설정).
- 지역활동기록(ORGACT), 활동 일괄 삭제, 이력에서 복원, 변경 전·후 상세 표시, 본인 비밀번호 변경.
- PSMSTR 의 실제 `EMPL_ID` 컬럼 형식 정합(스키마 주석: varchar(60), 현재 bigint 일 수 있음 — 인도자 검증 쿼리에 영향).
