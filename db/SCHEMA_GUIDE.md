# SMOA 전체 단순 스키마 가이드

- 신규 권장 DDL: `db/smoa-schema.sql` (새 DB 적용용 검토 파일, 이 문서와 한 쌍).
- `db/schema-draft.sql`, `db/permission-package.sql`은 **과거 참고 초안**이다. 이번에 수정하지 않았으며 신규 작업은 `smoa-schema.sql`을 기준으로 한다.
- 에이전트는 이 DDL을 DB에 적용하지 않았다. 실제 smoa DB와의 차이(컬럼 타입, 기존 PSMSTR/ORGMSTR/ORGDTL 정의)는 적용 전에 별도로 대조해야 한다.

## 공통 규칙

| 항목 | 규칙 |
|---|---|
| FK | **선언 없음**. ID는 참조값일 뿐이다. PK/UK/일반 INDEX만 사용. |
| 엔진/문자셋 | InnoDB, utf8mb4_general_ci. 해시·비밀번호해시만 ascii_bin. |
| SYS_* | `SYS_RUSR_ID/IP/DTTM`, `SYS_MUSR_ID/IP/DTTM`. 기본값 ADMIN/0.0.0.1/current_timestamp(). 수정시각 자동 ON UPDATE 없음 — Service가 채운다. |
| CHECK | 단순 범위/YN/코드 목록만. |
| 날짜·시간 | 공란은 NULL. 원본 날짜/시각을 보정하지 않는다. |
| 대소문자 | 마지막 확인값 `lower_case_table_names=0`, 목표값 1. 1은 OS 설정·재기동이 필요할 수 있어 DDL로 바뀌지 않는다. 이름은 모두 대문자로 일관 사용. |
| IF NOT EXISTS | 사용하지 않음(이미 존재하면 오류로 드러나야 한다). |

## 생성 순서

ORGMSTR → ORGDTL → PSMSTR → PGMMSTR → AUTHMSTR → AUTHDTL → AUTHORG → USERMSTR → LIBMSTR → CODEMSTR → CODEDTL → TGMSTR → TGSTGLOG → TGSTATLOG → ACTMSTR → ORGACT → CALLMSTR → SOCMSTR → SOCDTL → DAYMSTR → DAYDTL → GOALMSTR → SYSCFG → CHGLOG → MIGJOB → MIGMAP

FK가 없으므로 순서는 강제되지 않는다. 의존 순서로 두었을 뿐이다.

## 테이블 요약

| 테이블 | 역할 | 핵심 컬럼/키 | 서버에서 검증할 참조 |
|---|---|---|---|
| ORGMSTR | 지역 | PK ORG_MSTR_CODE | — |
| ORGDTL | 구역 | PK (ORG_MSTR_CODE, ORG_CODE) | 지역 존재 |
| PSMSTR | 조직원 명부 | PK EMPL_ID; ORG_MSTR_CODE(nullable)+ORG_CODE; NAME/TITLE/BAN/JOB/STATUS | 구역 존재 |
| PGMMSTR | 최하위 메뉴(프로그램) | PK PGM_ID(불변), UK PGM_URL, GROUP_NAME, PGM_SORT_NO, SUPER_ADMIN_IND, READ/WRITE/EXPORT_USE_IND | — |
| AUTHMSTR | 권한 패키지 | PK AUTH_CODE, DATA_SCOPE_CODE(ALL/ORG) | — |
| AUTHDTL | 패키지×프로그램 access/read/write/export | PK (AUTH_CODE, PGM_ID) | 패키지·프로그램 존재, 프로그램이 지원하지 않는 동작 부여 금지 |
| AUTHORG | 패키지 허용 구역 | PK (AUTH_CODE, ORG_MSTR_CODE, ORG_CODE) | 패키지·구역(복합키) 존재 |
| USERMSTR | 로그인 계정(패키지 1개 필수) | PK USER_ID, UK LOGIN_ID, AUTH_CODE NOT NULL, PASSWORD_HASH, EMPL_ID(선택) | 패키지 존재·사용중, 명부 존재 |
| LIBMSTR | 자료실(원본/이관 구분) | PK LIB_ID, LEGACY_LIB_ID | — |
| CODEMSTR / CODEDTL | 공통코드(단계는 STAGE 그룹) | PK GROUP_CODE / (GROUP_CODE, ITEM_CODE), ALIASES_JSON | 그룹 존재 |
| TGMSTR | 대상자 | PK TGT_ID(AUTO_INCREMENT), LIB_ID, PHONE_ENC/PHONE_LAST4/PHONE_KEY_VER, SOURCE_ENC | 자료실·구역·EMPL_ID·단계 코드 |
| TGSTGLOG / TGSTATLOG | 단계/상태 변경 이력 | PK 자동, UK (TGT_ID, SEQ_NO) | 대상자 존재 |
| ACTMSTR | 활동(대상자/독립 통합) | PK ACT_ID, TGT_ID nullable, ACT_MINUTES | 대상자(있으면), 활동자 |
| ORGACT | 조직원 활동 상태 | UK (LIB_ID, EMPL_ID, PERIOD_KEY), ACT_STATUS_CODE 1~4 | 구역 |
| CALLMSTR | 콜링 | PK CALL_ID, TGT_ID nullable, ATTEMPT_KEY_HASH(일반 INDEX) | 대상자(있으면) |
| SOCMSTR / SOCDTL | 소셜링 모임 / 유입 | PK (LIB_ID, SOC_ID) / SOC_DTL_ID | 모임 존재, 대상자(전환 시) |
| DAYMSTR | 일보 합계 | UK (LIB_ID, 지역, 구역, REPORT_DATE) | 구역 |
| DAYDTL | 일보 상세 | PK DAY_DTL_ID | 대상자(있으면), 구역 |
| GOALMSTR | 목표 | PK GOAL_ID, PERIOD_CODE week/month/custom, TARGET_CNT≥0 | 구역, 중복 기간 |
| SYSCFG | 설정 | PK (LIB_ID, CONFIG_CODE) | — |
| CHGLOG | 변경 이력 | PK CHG_ID, PREV_HASH/ENTRY_HASH | — |
| MIGJOB / MIGMAP | 이관 작업 / ID 매핑 | PK JOB_ID / UK (LIB_ID, ENTITY_KIND, SOURCE_ID) | 작업 존재 |

## 핵심 설계 결정

1. **계정·권한은 전역**이다. 자료실(LIB_ID)은 업무 자료(TGMSTR 이하)에만 붙는다.
2. **CODEDTL은 전역**(PK에 LIB_ID 없음). 자료실별 단계/코드 표기 차이는 `ALIASES_JSON`에 별칭으로 넣고, 매핑되지 않는 값은 이관 보고서에 올려 사람이 결정한다. 같은 코드가 자료실마다 다른 의미라면 코드를 새로 부여해 구분한다.
3. **대상자 중복 허용**: TGMSTR에는 이름·연락처·TGT_CODE·LEGACY_ID에 UNIQUE가 없다. 동일한 내용도 서로 다른 TGT_ID로 유지한다. 이름·전화번호로 병합하지 않는다.
4. **연락처**: 평문 컬럼 없음. `PHONE_ENC`는 AES-GCM 봉투(키버전/nonce/tag/ciphertext). 같은 연락처도 매번 랜덤 nonce로 암호화되므로 ciphertext UNIQUE 금지. 키는 DB·소스 밖 환경/보안 파일에 둔다. 일반 API·엑셀·로그·변경 이력에는 `PHONE_LAST4`만 반환한다.
5. **스냅샷 vs 현재값**: TGMSTR.EMPL_ID가 현재 인도자(PSMSTR 조회). `INTRO_*`는 연결 당시 표기. 단계/상태 이력은 현재 정보와 별도로 보존한다.
6. **시각**: `APPLY_DTTM`은 한국 업무시각, `RECORDED_DTTM`은 시스템(UTC) 기록시각으로 구분한다.
7. **UNIQUE를 두지 않은 곳**: CALLMSTR.ATTEMPT_KEY_HASH, SOCDTL.TGT_ID, ACTMSTR.SESSION_KEY, DAYDTL. 레거시 중복을 검토하기 전에는 일반 INDEX만 둔다. 이관 중복은 MIGMAP이 막는다.
8. **GOALMSTR 중복**: NULL 유일성 트릭·생성 컬럼을 쓰지 않는다. 같은 (LIB_ID, 구역, 반, 기간, 단계, PERIOD_CODE) 중복은 Service가 저장 전에 검사한다.
9. **원본 보존**: 엑셀·원본에 있는 항목을 조용히 버리지 않는다. 컬럼으로 분류되지 않는 알 수 없는 필드는 `SOURCE_ENC`(암호화)에 넣는다. SYSCFG/CHGLOG/MIGJOB에는 키·비밀번호·연락처 평문을 저장하지 않는다.

## 대상자 엑셀(`reports.cjs` COLUMNS) ↔ 테이블 대응

| 엑셀 key | 헤더 | 저장 위치 | 분류 |
|---|---|---|---|
| code | 대상자 식별번호 | TGMSTR.TGT_CODE | 컬럼 |
| name | 대상자 | TGMSTR.TGT_NAME_HAN | 컬럼 |
| phone | PHONE_HEADER(연락처) | TGMSTR.PHONE_ENC(전체, 암호화) / PHONE_LAST4(출력은 끝 네 자리만) | 컬럼(암호화) |
| gender | 성별 | TGMSTR.SEX_CODE | 컬럼 |
| age | 나이 | TGMSTR.AGE | 컬럼 |
| ageAsOf | 나이 기준일 | TGMSTR.AGE_BASE_DATE | 컬럼 |
| date | 등록일(찾은 날짜) | TGMSTR.FOUND_DATE (+DATE_UNKNOWN_IND) | 컬럼 |
| time | 찾기 시간 | TGMSTR.FOUND_TIME | 컬럼 |
| classification1 | 분류1 | TGMSTR.CLASS1_CODE | 컬럼 |
| classification2 | 분류2 | TGMSTR.CLASS2_CODE | 컬럼 |
| place | 찾기 장소 | TGMSTR.PLACE_NAME | 컬럼 |
| tool | 사용 도구 | TGMSTR.TOOL_NAME | 컬럼 |
| residence | 거주지 | TGMSTR.RESIDENCE | 컬럼 |
| teacher | 교사 | TGMSTR.TEACHER_NAME | 컬럼 |
| reason | 사유 | TGMSTR.REASON | 컬럼 |
| manpikDate | 만픽일 | TGMSTR.MANPIK_DATE | 컬럼 |
| findADate | 찾A날짜 | TGMSTR.FIND_A_DATE | 컬럼 |
| habBDate | 합B | TGMSTR.HAB_B_DATE | 컬럼 |
| habADate | 합A(육따)일 | TGMSTR.HAB_A_DATE | 컬럼 |
| youngTtaDate | 영따 | TGMSTR.YOUNG_TTA_DATE | 컬럼 |
| bokshinDate | 복신일 | TGMSTR.BOKSHIN_DATE | 컬럼 |
| cardReceivedDate | 신카접수일 | TGMSTR.CARD_RECEIVED_DATE | 컬럼 |
| centerRegisteredDate | 센터등록일 | TGMSTR.CENTER_REGISTERED_DATE | 컬럼 |
| stage | 현재 단계 | TGMSTR.STAGE_CODE → CODEDTL(STAGE).ITEM_NAME | 컬럼+코드 |
| status | 현재 상태 | TGMSTR.STATUS_CODE | 컬럼 |
| worker | 담당자 | TGMSTR.WORKER_NAME | 컬럼 |
| region | 현재 구역 | TGMSTR.ORG_MSTR_CODE+ORG_CODE → ORGMSTR/ORGDTL 이름 조회 | 컬럼+조회 |
| className | 반 | TGMSTR.BAN_CODE | 컬럼 |
| employment | 직업 구분 | TGMSTR.JOB_CODE | 컬럼 |
| appointment | 확정 일정 | TGMSTR.APPOINTMENT_TEXT | 컬럼 |
| activityCount | 활동 건수 | **저장 안 함** — ACTMSTR에서 TGT_ID별 COUNT 계산 | 계산 |
| activityMinutes | 활동 시간(분) | **저장 안 함** — ACTMSTR에서 SUM(ACT_MINUTES) 계산 | 계산 |
| notes | 메모 | TGMSTR.NOTES | 컬럼 |
| introducerCode | 인도자 구성원ID | 현재값: PSMSTR.EMPL_CODE(EMPL_ID로 조회). 없으면 TGMSTR.INTRO_EMPL_CODE | 조회/스냅샷 |
| introducerName | 현재 인도자 이름 | PSMSTR.NAME(EMPL_ID로 조회). 없으면 TGMSTR.INTRO_NAME | 조회/스냅샷 |
| introducerUnit | 현재 인도자 소속 | PSMSTR 소속(ORG_MSTR_CODE/ORG_CODE)→ORGMSTR/ORGDTL 조회 | 조회 |
| introducerOriginalUnit | 인도자 연결 당시 소속 | TGMSTR.INTRO_ORG_SNAPSHOT | 스냅샷 |
| `custom:<id>` | 사용자 정의 항목 | 값: TGMSTR.CUSTOM_JSON, 정의(id/라벨/형식): SYSCFG | JSON+설정 |
| (엑셀에 없는 알 수 없는 추가 열) | — | TGMSTR.SOURCE_ENC | 암호화 원본 |

PHONE_HEADER가 가리키는 열 이름은 이번 작업에서 `person-phone.cjs`를 읽지 않아 확인하지 못했다. 엑셀의 연락처는 끝 네 자리만 내보낸다는 프로젝트 규칙을 따른다.

## 단순 예시

```sql
-- 구역 허용 패키지의 대상자 조회(서버가 AUTHORG 구역 조건을 붙임)
SELECT T.TGT_ID, T.TGT_NAME_HAN, T.PHONE_LAST4, T.FOUND_DATE, T.STAGE_CODE
  FROM TGMSTR T
 WHERE T.LIB_ID = ?
   AND (T.ORG_MSTR_CODE, T.ORG_CODE) IN (SELECT ORG_MSTR_CODE, ORG_CODE FROM AUTHORG WHERE AUTH_CODE = ?);

-- 활동 건수/시간 계산
SELECT TGT_ID, COUNT(*) AS ACTIVITY_COUNT, COALESCE(SUM(ACT_MINUTES),0) AS ACTIVITY_MINUTES
  FROM ACTMSTR WHERE LIB_ID = ? GROUP BY TGT_ID;
```

## FK 대신 서버가 검증할 항목 (Service 트랜잭션)

| 상황 | 검증 |
|---|---|
| 계정 생성/수정 | AUTH_CODE가 존재하고 사용중인 패키지인가, EMPL_ID가 있으면 PSMSTR에 존재하는가. 패키지 없는 계정 금지. |
| 패키지 삭제 | 연결된 USERMSTR이 있으면 차단. AUTHDTL/AUTHORG는 같은 트랜잭션에서 함께 처리. |
| 프로그램 삭제/비활성 | AUTHDTL에 쓰이는 PGM_ID는 삭제 차단(비활성만 허용). PGM_ID는 변경 금지. |
| AUTHDTL 저장 | 프로그램의 READ/WRITE/EXPORT_USE_IND가 N인 동작은 Y로 저장 금지. SUPER_ADMIN_IND 프로그램은 총관리자 패키지만. |
| 구역 지정 | (ORG_MSTR_CODE, ORG_CODE) 복합키로 ORGDTL 존재 확인. 지역만 따로 맞추는 검사 금지. |
| 조직/구역/명부 삭제 | AUTHORG, PSMSTR, TGMSTR 등이 참조하면 차단(고아 참조 방지). |
| 대상자 저장 | LIB_ID, 구역, EMPL_ID, STAGE/STATUS 코드 유효성, AGE 0~120, ROW_VERSION 낙관적 잠금. 삭제 시 이력/활동/콜링/일보 처리 방침(차단 또는 TGT_ID NULL 처리)을 Service가 명시. |
| 활동·콜링·소셜링·일보 | TGT_ID가 있으면 존재와 접근 권한(구역) 확인. 없으면 독립/미연결로 허용. |
| 모든 조회 | 현재 계정의 패키지 DATA_SCOPE_CODE와 AUTHORG를 서버에서 적용. 클라이언트 값 신뢰 금지. |
| 이관 | MIGMAP UK로 같은 원본 ID 재이관 방지. 건수/참조/집계 대조 후 완료 표시. |

## 남은 사항

- ORGMSTR/ORGDTL/PSMSTR는 사용자 제공 원본 명세를 직접 보지 못해 최소 컬럼(이름, 정렬, 사용여부 등)으로 작성했다. 실제 명세와 컬럼명·길이를 대조해 맞춰야 한다.
- 기존 smoa DB에 이미 있는 테이블과 충돌하면 이 DDL은 오류를 낸다(의도됨). 실제 스키마와의 차이는 별도 검토한다.
- 자료실별 코드 충돌과 레거시 중복(콜링 해시, 일보 상세, 소셜링 전환)은 원본 확인 후 UNIQUE 도입 여부를 결정한다.
