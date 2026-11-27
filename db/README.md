# SMOA DB 스키마 초안

- 설계 기준: [docs/DB_TABLE_DESIGN.md](../docs/DB_TABLE_DESIGN.md)
- DDL: [db/schema-draft.sql](schema-draft.sql) (MariaDB 10.11 검토용)

## 현재 상태

- **DB에 적용하지 않았고 실행 테스트도 하지 않았다.** DDL 문법·FK·CHECK는 MariaDB로 검증되지 않았다. 첫 실행 전 Codex 검토와 사용자의 사전 점검이 필요하다.
- **기존 웹 앱은 여전히 메모리 저장이다.** 이 DDL을 적용해도 앱이 DB에 연결되지 않는다. 저장소 연결, 트랜잭션, 동시 수정(`people.row_version`) 처리는 별도 구현이다.
- 파일은 `DROP`/`DELETE`/`TRUNCATE`/`USE`/`CREATE DATABASE`/권한문/`INSERT`/트리거/프로시저를 포함하지 않는다. 실행 대상 데이터베이스는 클라이언트에서 미리 선택한다.
- `IF NOT EXISTS`를 쓰지 않는다. 같은 이름의 테이블이 있으면 오류로 멈춘다(기존 스키마와의 불일치를 숨기지 않기 위함).
- MariaDB의 DDL은 암묵적 커밋이므로 **중간 실패 시 자동 롤백되지 않는다.** 실패하면 `information_schema.TABLES`로 생성된 테이블을 확인해 사용자가 정리 방법을 정한다.
- 설계서 본문의 "29개" 기준과 달리 설계서에 열거된 테이블은 28개이며 DDL은 그 28개를 만든다(아래 목록 참고).

## 테이블 (생성 순서)

| 영역 | 테이블 |
|---|---|
| 조직·계정·권한 | `app_roles`, `org_units`, `members`, `app_users`, `user_districts`, `role_screen_permissions` |
| 코드·설정 | `stages`, `code_groups`, `code_items`, `custom_fields`, `app_settings` |
| 이관 작업(먼저 생성) | `import_jobs` |
| 대상자·이력 | `people`, `person_custom_values`, `person_stage_events`, `person_stage_dates`, `person_status_events` |
| 활동·일보·목표 | `activity_records`, `regional_activity_records`, `daily_area_reports`, `daily_finding_reports`, `goals` |
| 콜링·소셜링 | `calling_records`, `socialing_programs`, `socialing_intakes` |
| 이력·이관 | `audit_logs`, `import_rows`, `legacy_id_map` |

- 부모 테이블을 먼저 만든다. `import_jobs`는 `calling_records`·`audit_logs`·`legacy_id_map`이 참조하므로 앞에 둔다.
- `org_units.leader_member_id`는 `org_units`↔`members` 순환 참조이므로 파일 끝의 `ALTER TABLE`로 FK를 추가한다. 이관 때는 NULL로 두었다가 구성원 적재 후 연결한다.
- `app_roles`/`app_users`는 웹 앱의 역할·계정이다. MariaDB root 등 DB 관리 계정과 별개이며 DB 계정·권한은 이 파일이 만들거나 바꾸지 않는다.

## ID·문자셋·비교 규칙

| 구분 | 타입 | 비교 |
|---|---|---|
| 내부 ID·참조(FK) | `VARCHAR(80) ascii_bin` | 정확 비교(대소문자 구분). FK는 부모 키와 타입·문자셋·collation이 같다 |
| 사용자 표시명·검색값(이름, 구역명, 로그인 이름 `username`, 코드 `label`) | `utf8mb4_general_ci` | 대소문자 무시 |
| 원본 코드·키(`code`, `stage_key`, `group_key`, `code_items.value`, `source_*`, `normalized_name_key`, `target_id`) | `utf8mb4_bin` | 정확 비교 |
| `password_hash`, `attempt_key_hash`, `*_sha256`, `entry_hash` | `ascii_bin` | 정확 비교 |

- 한글이 들어 있는 기존 단계 원본 ID는 `stages.id`에 쓰지 않고 `legacy_id_map.source_id`(`utf8mb4_bin`)에 원문 그대로 보존한다.
- `username`은 ci UNIQUE이므로 `Admin`과 `admin`이 중복으로 판정된다. 코드·키류는 bin이므로 대소문자가 다르면 다른 값이다.
- 목록 검색의 ci 설정이 기존 앱의 NFKC·공백 정규화를 대신하지 않는다. 정규화 키(`socialing_programs.normalized_name_key`, `calling_records.attempt_key_hash`)는 앱이 기존 규칙으로 계산해서 넣는다.
- 시각: 시스템 `created_at`/`updated_at`/`recorded_at`은 UTC `DATETIME(3)`이며 **앱이 값을 넣는다(DB 기본값 없음)**. 업무 날짜·시각은 한국 기준 `DATE`/`TIME`/`DATETIME`이고 미입력은 NULL이다.

## 주요 제약

- **JSON 컬럼**(`aliases_json`, `options_json`, `value_json`, `before_json`, `after_json`)은 MariaDB에서 `LONGTEXT`(`utf8mb4_bin`) + `JSON_VALID` 검사의 별칭이다. 내부 값 비교가 bin으로 동작하므로 검색에는 추출값을 명시적으로 비교한다. **연락처·키·토큰을 JSON에 넣지 않는다.**
- **삭제 정책**: 이력·실적 테이블에는 `ON DELETE CASCADE`를 쓰지 않는다. 명부·대상자 연결이 선택인 기록(`activity_records`, `calling_records`, `regional_activity_records`, `daily_finding_reports`)의 FK는 nullable + `ON DELETE SET NULL`이며 이름·코드·구역 스냅샷이 남는다. 단계 이동·상태 이력·단계일의 `person_id`는 NOT NULL + 삭제 제한이므로 대상자를 삭제하려면 앱이 명시적으로 이력 처리 방법을 정해야 한다. CASCADE는 순수 연결·값 테이블(`user_districts`, `role_screen_permissions`, `person_custom_values`)에만 있다.
- **`role_screen_permissions`**: 접근 꺼짐 → 조회·쓰기·내보내기 꺼짐, 조회 꺼짐 → 쓰기·내보내기 꺼짐.
- **`person_custom_values`**: 네 값 컬럼 중 정확히 하나만 값을 갖는다(미입력은 행 없음). `custom_fields.field_type`과 실제 값 컬럼의 대응은 DB가 아니라 앱에서 검증한다.
- **`goals`**: 전체 단계는 `stage_id` NULL + `stage_scope_key='*'`, 특정 단계는 `stage_scope_key=stage_id`(CHECK). NULL은 UNIQUE에서 중복을 허용하므로 NOT NULL인 `stage_scope_key`를 `uq_goals_scope`에 넣어 중복을 막는다. 구역·반 미선택은 빈 문자열이며 둘 다 빈 값은 금지한다.
- **`regional_activity_records`**: `(source_namespace, source_member_id, period_key)` UNIQUE. 월 기록은 `record_date` NULL + `period_key=record_month`, 일 기록은 `period_key=YYYY-MM-DD`이며 `record_month`와 일치해야 한다(CHECK). 현재 명부에 없는 과거 ID는 `member_id` NULL로 두고 `source_member_id`와 스냅샷으로 보존한다.
- **`calling_records`**: `round_number` 0~5, `round_name` 최대 60자. `original_result`와 `reported_result`는 둘 다 보존하되 동시에 입력할 수 없다. 미연결 자료는 `person_id` NULL. `attempt_key_hash`(SHA-256)는 UNIQUE이며 **앱이 기존 `calling.cjs`의 `attemptKey` 규칙으로 계산**한다(특이사항 제외). `session_key`(활동)는 그룹 식별자이므로 UNIQUE가 아니다.
- **단계·상태 이력**: `effective_local`(업무 발생 일시)과 `recorded_at`(시스템 기록 UTC)을 구분하고 `(person_id, sequence_no)`가 유일하다. `baseline`과 `time_unknown`을 보존한다. 단계일(`person_stage_dates`)은 이력과 별개이다.
- **`socialing_intakes`**: 같은 행에서 `pending`→`converted`로 전환한다. `pending`은 `intake_date` 필수·`person_id`/`converted_at` NULL, `converted`는 `person_id` 필수. 옛 `person.socialing` 이관분은 `converted`에 `intake_date` NULL을 허용한다. `person_id`는 UNIQUE라 한 대상자의 재전환 중복을 막는다.
- **감사·이관**: `audit_logs`의 `before_json`/`after_json`에는 마스킹된 내용만 넣는다. 개인정보를 가리면 기존 해시 사슬이 유지되지 않으므로, 기존 사슬은 출처별로 검증하고 그 검증 결과와 출처 digest는 `import_jobs`/`import_rows`(`row_sha256`)에 기록하며, 웹용 마스킹 이력은 새 `chain_key`의 사슬로 연결한다. 감사 대상(`target_id`)은 삭제된 항목이나 설정 키일 수 있어 FK를 두지 않는다. `import_jobs`는 `(source_namespace, file_sha256, mapping_version, import_kind)`가 유일하므로 같은 파일의 재실행은 새 작업을 만들지 않고 기존 작업의 상태·행 결과·`legacy_id_map`을 확인한다.

## 인덱스

설계서 4절 기준을 반영했다. 사람(`district_id,status,stage_id` 등), 단계 이력(`person_id,effective_local` 등), 활동, 콜링, 지역활동, 일보, 감사 인덱스는 `KEY ix_*`로 정의했다. `%검색어%` 같은 선행 와일드카드 검색은 B-tree 효율을 보장하지 않으므로 실제 자료량으로 측정한 뒤 조정한다.

## 전제: `lower_case_table_names=1`

- 테이블명은 소문자 snake_case로 작성했다. 사용자가 요구한 "테이블명 대소문자 무시"는 서버의 `lower_case_table_names=1`이 필요하다.
- **마지막으로 확인한 값은 0이다.** 이 설정은 서버 시작 옵션이며 **사용자가 서버 설정에서 별도로 적용**하고(MariaDB 재시작 필요) 값을 확인해야 한다. 이 파일은 설정을 바꾸지 않는다.
- 기존 DB에 이미 테이블이 있는 상태에서 값을 바꾸면 대소문자가 섞인 이름의 테이블을 찾지 못할 수 있으므로, 변경 전 기존 테이블 이름을 확인한다.

## DBeaver 실행 전 읽기 전용 점검 SQL

아래는 모두 `SELECT`/`SHOW`이다. 결과를 확인한 뒤 사용자가 직접 `schema-draft.sql`을 실행한다.

```sql
-- 1) 서버 버전과 대소문자 설정(기대: 10.11.x, lower_case_table_names = 1)
SELECT VERSION();
SHOW VARIABLES LIKE 'lower_case_table_names';

-- 2) 기본 문자셋·collation, 스토리지 엔진
SHOW VARIABLES LIKE 'character_set_server';
SHOW VARIABLES LIKE 'collation_server';
SHOW VARIABLES LIKE 'default_storage_engine';

-- 3) 대상 데이터베이스가 맞는지 확인(DBeaver에서 선택한 DB)
SELECT DATABASE();

-- 4) 같은 이름의 테이블이 이미 있는지(기대: 0행)
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND LOWER(TABLE_NAME) IN (
    'app_roles','org_units','members','app_users','user_districts','role_screen_permissions',
    'stages','code_groups','code_items','custom_fields','app_settings','import_jobs',
    'people','person_custom_values','person_stage_events','person_stage_dates','person_status_events',
    'activity_records','regional_activity_records','daily_area_reports','daily_finding_reports','goals',
    'calling_records','socialing_programs','socialing_intakes','audit_logs','import_rows','legacy_id_map'
  );

-- 5) 대상 DB의 기존 테이블 전체(전혀 다른 용도의 테이블과 섞이지 않는지 확인)
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME;

-- 6) 실행 계정에 필요한 권한(CREATE, ALTER, REFERENCES, INDEX)이 있는지 확인
SHOW GRANTS FOR CURRENT_USER();
```

실행 후에는 `information_schema.TABLES`(28개 생성 여부), `KEY_COLUMN_USAGE`/`REFERENTIAL_CONSTRAINTS`(FK), `CHECK_CONSTRAINTS`(CHECK)를 `SELECT`로 대조한다. 스키마 적용 자체는 DB를 변경하므로 사용자가 직접, 백업·대상 확인 후에만 수행한다.

## 후속 범위(이 초안에 포함하지 않음)

- **연락처·여백**: `people`에 전체 연락처 컬럼이 없다. 후속으로 `encrypted_contacts`(암호문·nonce·인증 태그·키 버전·끝 네 자리), `external_applications`(신청 ID·대상자 연결), `application_consents`(동의 문구 버전·선택·시각)를 분리 설계한다. 암호화 키는 DB·소스 밖에서 관리하며, 일반 API·엑셀에는 끝 네 자리만 반환하고 원문·암호문은 응답·로그·변경 이력에 넣지 않는다. 이번 스키마에서 구현 완료로 주장하지 않는다.
- **세션**: 현재 서버 메모리에서 토큰의 SHA-256만 보관한다. 다중 프로세스·재시작 후 유지가 필요할 때 별도 `sessions` 저장소를 설계하며, 토큰 평문 테이블은 만들지 않는다.
- **앱 연결·이관**: 저장소(DB) 연결 구현, 트랜잭션·동시 수정 검증, 실제 기존 자료 이관(기존 ID·참조·이력·재실행 중복 방지 포함)은 별도 작업이다.
