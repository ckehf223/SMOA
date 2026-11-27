-- =====================================================================
-- SMOA 웹 기본 스키마 초안 (MariaDB 10.11 검토용)
-- 기준 문서: docs/DB_TABLE_DESIGN.md
--
-- 상태: 검토용 초안. 어떤 DB에도 적용·실행·검증하지 않았다.
-- 실행 주체: 사용자가 db/README.md의 사전 점검을 마친 뒤 직접 실행한다.
-- 주의:
--  * DDL은 MariaDB에서 암묵적 커밋이 일어나므로 중간 실패 시 자동 롤백되지 않는다.
--    실패하면 어디까지 만들어졌는지 information_schema로 확인하고 사용자가 처리한다.
--  * IF NOT EXISTS를 쓰지 않는다. 이미 같은 이름의 테이블이 있으면 오류로 멈춰
--    기존 스키마와의 불일치를 숨기지 않는다.
--  * 데이터베이스 선택/생성, 삭제, 권한, INSERT, 트리거, 프로시저는 포함하지 않는다.
--    실행할 대상 데이터베이스는 클라이언트에서 미리 선택한다.
--  * 전제: lower_case_table_names=1 (README 참조). 테이블명은 소문자 snake_case.
--
-- 공통 규칙
--  * 기본: ENGINE=InnoDB, utf8mb4 / utf8mb4_general_ci (사용자 표시명·검색값은 대소문자 무시)
--  * 내부 ID: VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin (정확 비교)
--  * 정확 비교가 필요한 원본 코드/키: utf8mb4_bin, 해시: ascii_bin
--  * created_at/updated_at 등 시스템 시각은 UTC DATETIME(3)이며 앱이 값을 넣는다(DB 기본값 없음).
--  * 업무 날짜/시각은 한국 기준 DATE/TIME/DATETIME이며 미입력은 NULL이다.
--  * JSON 컬럼은 MariaDB에서 LONGTEXT(utf8mb4_bin) + JSON_VALID 검사의 별칭이다.
--    연락처·암호화 키·토큰을 JSON에 넣지 않는다.
--  * 이력·실적 FK에는 ON DELETE CASCADE를 쓰지 않는다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 조직·계정·권한
-- ---------------------------------------------------------------------

-- 웹 앱 역할. MariaDB root 등 DB 관리 계정과 무관하다.
CREATE TABLE app_roles (
  id          VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '역할 ID',
  name        VARCHAR(60) NOT NULL COMMENT '역할 이름(관리자·담당자·열람자 등, 대소문자 무시 중복 금지)',
  is_system   TINYINT(1) NOT NULL DEFAULT 0 COMMENT '시스템 기본 역할 여부(1이면 삭제·이름변경 금지는 앱에서 검증)',
  created_at  DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at  DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_app_roles_name (name),
  CONSTRAINT ck_app_roles_flag CHECK (is_system IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='웹 로그인 역할(DB 관리 계정과 별개)';

-- 지역·구역·하위 조직 트리. leader_member_id FK는 members 생성 후 ALTER로 추가한다.
CREATE TABLE org_units (
  id                VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '조직 ID',
  code              VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '조직 코드(정확 비교, 기존 코드 보존)',
  name              VARCHAR(100) NOT NULL COMMENT '조직 이름',
  unit_type         VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '조직 유형(지역/구역/하위 등의 키, 허용값은 앱에서 검증)',
  parent_id         VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '상위 조직 ID(최상위는 NULL). 순환·깊이 12 제한은 앱에서 검증',
  leader_member_id  VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '책임자 활동자 ID(members 생성 후 FK 추가)',
  leader_title      VARCHAR(60) NULL COMMENT '책임자 직함 표시',
  report_region     VARCHAR(100) NULL COMMENT '일보 구역명 매핑(미지정 NULL, 대소문자 무시 중복 금지)',
  active            TINYINT(1) NOT NULL DEFAULT 1 COMMENT '사용 여부(삭제보다 사용 중지 우선)',
  created_at        DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at        DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_units_code (code),
  UNIQUE KEY uq_org_units_report_region (report_region),
  KEY ix_org_units_parent (parent_id),
  KEY ix_org_units_leader (leader_member_id),
  KEY ix_org_units_name (name),
  CONSTRAINT fk_org_units_parent FOREIGN KEY (parent_id) REFERENCES org_units (id),
  CONSTRAINT ck_org_units_flags CHECK (active IN (0, 1)),
  CONSTRAINT ck_org_units_not_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT ck_org_units_name CHECK (CHAR_LENGTH(TRIM(name)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='지역·구역·하위 조직 트리';

-- 활동자·인도자 명부. 로그인 계정이나 대상자와 같은 레코드가 아니다.
CREATE TABLE members (
  id             VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '활동자 ID',
  code           VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '활동자 코드(정확 비교)',
  name           VARCHAR(100) NOT NULL COMMENT '이름(동명이인 가능)',
  unit_id        VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '소속 조직 ID',
  position_text  VARCHAR(100) NOT NULL DEFAULT '' COMMENT '직책',
  class_name     VARCHAR(100) NOT NULL DEFAULT '' COMMENT '반',
  employment_text VARCHAR(200) NOT NULL DEFAULT '' COMMENT '직업',
  status         VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active' COMMENT '상태(active/inactive)',
  notes          TEXT NULL COMMENT '비고',
  created_at     DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at     DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_members_code (code),
  KEY ix_members_unit_status (unit_id, status),
  KEY ix_members_name (name),
  CONSTRAINT fk_members_unit FOREIGN KEY (unit_id) REFERENCES org_units (id),
  CONSTRAINT ck_members_status CHECK (status IN ('active', 'inactive')),
  CONSTRAINT ck_members_name CHECK (CHAR_LENGTH(TRIM(name)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='활동자·인도자 명부';

-- 웹 로그인 사용자. 활동자 연결은 선택이다.
CREATE TABLE app_users (
  id                   VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '사용자 ID',
  username             VARCHAR(60) NOT NULL COMMENT '로그인 이름(대소문자 무시 유일)',
  display_name         VARCHAR(100) NOT NULL COMMENT '표시 이름',
  password_hash        VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '비밀번호 해시(정확 비교, 평문 저장 금지)',
  role_id              VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '역할 ID',
  member_id            VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '연결 활동자 ID(선택)',
  active               TINYINT(1) NOT NULL DEFAULT 1 COMMENT '로그인 허용 여부',
  is_root_admin        TINYINT(1) NOT NULL DEFAULT 0 COMMENT '앱 최고 관리자 여부(MariaDB root와 무관)',
  password_changed_at  DATETIME(3) NULL COMMENT '비밀번호 변경 시각(UTC)',
  created_at           DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at           DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_app_users_username (username),
  KEY ix_app_users_role (role_id),
  KEY ix_app_users_member (member_id),
  CONSTRAINT fk_app_users_role FOREIGN KEY (role_id) REFERENCES app_roles (id),
  CONSTRAINT fk_app_users_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE SET NULL,
  CONSTRAINT ck_app_users_flags CHECK (active IN (0, 1) AND is_root_admin IN (0, 1)),
  CONSTRAINT ck_app_users_username CHECK (CHAR_LENGTH(TRIM(username)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='웹 로그인 사용자(활동자·대상자와 별개)';

-- 사용자별 허용 구역. 해당 조직이 구역 유형인지는 앱에서 검증한다.
CREATE TABLE user_districts (
  user_id      VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '사용자 ID',
  district_id  VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '허용 구역(조직) ID',
  created_at   DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  PRIMARY KEY (user_id, district_id),
  KEY ix_user_districts_district (district_id),
  CONSTRAINT fk_user_districts_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_districts_district FOREIGN KEY (district_id) REFERENCES org_units (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='사용자별 접근 허용 구역';

-- 역할별 화면 권한.
CREATE TABLE role_screen_permissions (
  role_id     VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '역할 ID',
  screen_key  VARCHAR(60) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '화면 키(정확 비교)',
  can_access  TINYINT(1) NOT NULL DEFAULT 0 COMMENT '화면 접근',
  can_read    TINYINT(1) NOT NULL DEFAULT 0 COMMENT '조회',
  can_write   TINYINT(1) NOT NULL DEFAULT 0 COMMENT '등록·수정·삭제',
  can_export  TINYINT(1) NOT NULL DEFAULT 0 COMMENT '내보내기',
  updated_at  DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (role_id, screen_key),
  CONSTRAINT fk_role_screen_permissions_role FOREIGN KEY (role_id) REFERENCES app_roles (id) ON DELETE CASCADE,
  CONSTRAINT ck_role_screen_permissions_flags CHECK (
    can_access IN (0, 1) AND can_read IN (0, 1) AND can_write IN (0, 1) AND can_export IN (0, 1)
  ),
  -- 접근 꺼짐 → 나머지 전부 꺼짐, 조회 꺼짐 → 쓰기·내보내기 꺼짐
  CONSTRAINT ck_role_screen_permissions_chain CHECK (
    (can_access = 1 OR (can_read = 0 AND can_write = 0 AND can_export = 0))
    AND (can_read = 1 OR (can_write = 0 AND can_export = 0))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='역할별 화면 권한';

-- ---------------------------------------------------------------------
-- 2. 코드·설정
-- ---------------------------------------------------------------------

-- 단계 사전. 고정 ENUM을 쓰지 않는다. 한글 원본 단계 ID는 legacy_id_map에 보존한다.
CREATE TABLE stages (
  id          VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '단계 ID',
  stage_key   VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '단계 키(정확 비교)',
  name        VARCHAR(100) NOT NULL COMMENT '단계 표시 이름',
  sort_order  INT NOT NULL DEFAULT 0 COMMENT '정렬 순서',
  active      TINYINT(1) NOT NULL DEFAULT 1 COMMENT '사용 여부(삭제보다 사용 중지)',
  created_at  DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at  DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_stages_key (stage_key),
  KEY ix_stages_sort (sort_order),
  CONSTRAINT ck_stages_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='단계 사전';

CREATE TABLE code_groups (
  id         VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '코드 그룹 ID',
  group_key  VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '그룹 키(정확 비교)',
  label      VARCHAR(100) NOT NULL COMMENT '그룹 표시 이름',
  is_system  TINYINT(1) NOT NULL DEFAULT 0 COMMENT '시스템 그룹 여부',
  active     TINYINT(1) NOT NULL DEFAULT 1 COMMENT '사용 여부',
  created_at DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_code_groups_key (group_key),
  CONSTRAINT ck_code_groups_flags CHECK (is_system IN (0, 1) AND active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='공통코드 그룹';

CREATE TABLE code_items (
  id          VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '코드 항목 ID',
  group_id    VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '코드 그룹 ID',
  value       VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '저장 값(정확 비교, 기존 코드값 보존)',
  label       VARCHAR(100) NOT NULL COMMENT '표시 이름(검색은 대소문자 무시)',
  aliases_json JSON NULL COMMENT '별칭 배열(JSON). 검색은 추출값을 명시 비교',
  sort_order  INT NOT NULL DEFAULT 0 COMMENT '정렬 순서',
  active      TINYINT(1) NOT NULL DEFAULT 1 COMMENT '사용 여부(비활성이어도 과거값 유지)',
  created_at  DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at  DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_code_items_group_value (group_id, value),
  KEY ix_code_items_group_sort (group_id, sort_order),
  KEY ix_code_items_label (label),
  CONSTRAINT fk_code_items_group FOREIGN KEY (group_id) REFERENCES code_groups (id),
  CONSTRAINT ck_code_items_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='반·직업·직책·활동종류·장소 등 공통코드 값';

-- 사용자 정의 대상자 항목. 유형별 허용값과 값 대응은 앱(API)에서 검증한다.
CREATE TABLE custom_fields (
  id             VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '사용자 항목 ID',
  label          VARCHAR(100) NOT NULL COMMENT '항목 이름',
  field_type     VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '항목 유형 키(허용 유형은 앱에서 검증)',
  code_group_id  VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '선택형 항목의 코드 그룹 ID',
  options_json   JSON NULL COMMENT '선택 옵션(JSON, 기존 키·순서 보존)',
  sort_order     INT NOT NULL DEFAULT 0 COMMENT '정렬 순서',
  active         TINYINT(1) NOT NULL DEFAULT 1 COMMENT '사용 여부',
  created_at     DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at     DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  KEY ix_custom_fields_sort (sort_order),
  KEY ix_custom_fields_code_group (code_group_id),
  CONSTRAINT fk_custom_fields_code_group FOREIGN KEY (code_group_id) REFERENCES code_groups (id),
  CONSTRAINT ck_custom_fields_active CHECK (active IN (0, 1)),
  CONSTRAINT ck_custom_fields_label CHECK (CHAR_LENGTH(TRIM(label)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='사용자 정의 대상자 항목';

-- 조직 공통 설정. 비밀 값(키·토큰·비밀번호)을 넣지 않는다.
CREATE TABLE app_settings (
  setting_key  VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '설정 키(정확 비교)',
  value_json   JSON NOT NULL COMMENT '설정 값(JSON, 비밀 값 금지)',
  updated_at   DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='조직 공통 설정(주 시작 요일·일보 열 배치 등)';

-- ---------------------------------------------------------------------
-- 3. 이관 작업(감사·콜링이 참조하므로 먼저 생성)
-- ---------------------------------------------------------------------

CREATE TABLE import_jobs (
  id                VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '가져오기 작업 ID',
  import_kind       VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '가져오기 종류(엑셀·일보·기존자료 이관 등)',
  source_namespace  VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '원본 출처 구분(기존 자료실 식별용, 자료실 관리 기능 아님)',
  file_sha256       CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '원본 파일 SHA-256(소문자 16진). 파일명·본문은 저장하지 않음',
  mapping_version   VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '매핑 규칙 버전',
  status            VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '상태(planned/validated/applying/succeeded/failed/cancelled)',
  total_count       INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '전체 행 수',
  inserted_count    INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '추가 행 수',
  updated_count     INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '갱신 행 수',
  skipped_count     INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '건너뜀 행 수',
  error_count       INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '오류 행 수',
  actor_user_id     VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '실행 사용자 ID',
  started_at        DATETIME(3) NOT NULL COMMENT '시작 시각(UTC)',
  finished_at       DATETIME(3) NULL COMMENT '종료 시각(UTC, 진행 중이면 NULL)',
  PRIMARY KEY (id),
  -- 같은 파일·규칙의 재실행은 새 작업을 만들지 않고 기존 작업 상태를 확인한다.
  UNIQUE KEY uq_import_jobs_source (source_namespace, file_sha256, mapping_version, import_kind),
  KEY ix_import_jobs_actor (actor_user_id),
  KEY ix_import_jobs_status (status, started_at),
  CONSTRAINT fk_import_jobs_actor FOREIGN KEY (actor_user_id) REFERENCES app_users (id) ON DELETE SET NULL,
  CONSTRAINT ck_import_jobs_status CHECK (status IN ('planned', 'validated', 'applying', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT ck_import_jobs_sha CHECK (file_sha256 REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT ck_import_jobs_period CHECK (finished_at IS NULL OR finished_at >= started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='엑셀·일보·기존자료 이관 작업';

-- ---------------------------------------------------------------------
-- 4. 대상자와 이력
-- ---------------------------------------------------------------------

-- 전체 연락처 컬럼을 두지 않는다(후속 encrypted_contacts 등에서 분리 설계).
CREATE TABLE people (
  id                          VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '대상자 ID',
  code                        VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '대상자 코드(정확 비교)',
  name                        VARCHAR(100) NOT NULL COMMENT '이름(동명이인 가능)',
  gender                      VARCHAR(20) NOT NULL DEFAULT '' COMMENT '성별',
  age                         SMALLINT UNSIGNED NULL COMMENT '나이(0~120, 미입력 NULL)',
  age_as_of                   DATE NULL COMMENT '나이 기준일',
  classification1             VARCHAR(60) NOT NULL DEFAULT '' COMMENT '분류1',
  classification2             VARCHAR(60) NOT NULL DEFAULT '' COMMENT '분류2',
  found_date                  DATE NULL COMMENT '찾은 날짜(미입력 NULL, 오늘 날짜로 채우지 않음)',
  found_time                  TIME NULL COMMENT '찾은 시각(미입력 NULL, 0시로 채우지 않음)',
  date_unknown                TINYINT(1) NOT NULL DEFAULT 0 COMMENT '날짜 미상 표시(1이면 found_date는 NULL)',
  region_name                 VARCHAR(100) NOT NULL DEFAULT '' COMMENT '구역 표기(현재 FK가 없는 과거 표기도 보존)',
  district_id                 VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '연결된 구역(조직) ID(이름만 보고 확정하지 않음)',
  class_name                  VARCHAR(100) NOT NULL DEFAULT '' COMMENT '반',
  employment_text             VARCHAR(200) NOT NULL DEFAULT '' COMMENT '직업',
  introducer_member_id        VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '인도자 활동자 ID(명부에서 사라지면 NULL, 스냅샷 유지)',
  introducer_code_snapshot    VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' COMMENT '인도자 코드 스냅샷',
  introducer_name_snapshot    VARCHAR(100) NOT NULL DEFAULT '' COMMENT '인도자 이름 스냅샷',
  worker_name                 VARCHAR(100) NOT NULL DEFAULT '' COMMENT '담당자 이름',
  stage_id                    VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '현재 단계 ID',
  status                      VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active' COMMENT '상태(active/dropped)',
  place                       VARCHAR(200) NOT NULL DEFAULT '' COMMENT '장소',
  tool                        VARCHAR(200) NOT NULL DEFAULT '' COMMENT '도구',
  residence                   VARCHAR(200) NOT NULL DEFAULT '' COMMENT '거주지',
  teacher_name                VARCHAR(100) NOT NULL DEFAULT '' COMMENT '교사 이름',
  reason                      VARCHAR(500) NOT NULL DEFAULT '' COMMENT '사유',
  appointment_date            DATE NULL COMMENT '약속일',
  notes                       TEXT NULL COMMENT '비고',
  row_version                 INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '동시 수정 충돌 감지용 버전',
  created_at                  DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at                  DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_people_code (code),
  KEY ix_people_district_status_stage (district_id, status, stage_id),
  KEY ix_people_region_found (region_name, found_date),
  KEY ix_people_introducer_found (introducer_member_id, found_date),
  KEY ix_people_name (name),
  KEY ix_people_stage (stage_id),
  CONSTRAINT fk_people_district FOREIGN KEY (district_id) REFERENCES org_units (id) ON DELETE SET NULL,
  CONSTRAINT fk_people_introducer FOREIGN KEY (introducer_member_id) REFERENCES members (id) ON DELETE SET NULL,
  CONSTRAINT fk_people_stage FOREIGN KEY (stage_id) REFERENCES stages (id),
  CONSTRAINT ck_people_status CHECK (status IN ('active', 'dropped')),
  CONSTRAINT ck_people_age CHECK (age IS NULL OR age BETWEEN 0 AND 120),
  CONSTRAINT ck_people_date_unknown CHECK (date_unknown IN (0, 1) AND (date_unknown = 0 OR found_date IS NULL)),
  CONSTRAINT ck_people_name CHECK (CHAR_LENGTH(TRIM(name)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='대상자 현재 상태';

-- 미입력은 행을 만들지 않는다. 네 값 컬럼 중 정확히 하나만 값을 가진다.
CREATE TABLE person_custom_values (
  person_id      VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '대상자 ID',
  field_id       VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '사용자 항목 ID',
  value_text     TEXT NULL COMMENT '문자 값',
  value_number   DECIMAL(20,6) NULL COMMENT '숫자 값',
  value_date     DATE NULL COMMENT '날짜 값',
  value_boolean  TINYINT(1) NULL COMMENT '예/아니오 값(0/1)',
  updated_at     DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (person_id, field_id),
  KEY ix_person_custom_values_field (field_id),
  CONSTRAINT fk_person_custom_values_person FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE CASCADE,
  CONSTRAINT fk_person_custom_values_field FOREIGN KEY (field_id) REFERENCES custom_fields (id),
  CONSTRAINT ck_person_custom_values_one CHECK (
    (value_text IS NOT NULL) + (value_number IS NOT NULL) + (value_date IS NOT NULL) + (value_boolean IS NOT NULL) = 1
  ),
  CONSTRAINT ck_person_custom_values_bool CHECK (value_boolean IS NULL OR value_boolean IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='대상자 사용자 항목 값(field_type과의 대응은 앱에서 검증)';

CREATE TABLE person_stage_events (
  id                  VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '단계 이동 이력 ID',
  person_id           VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '대상자 ID',
  sequence_no         INT UNSIGNED NOT NULL COMMENT '대상자별 이력 순번(날짜와 별개로 순서 보존)',
  from_stage_id       VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '이전 단계 ID(최초 기록은 NULL)',
  to_stage_id         VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '이동 단계 ID',
  from_name_snapshot  VARCHAR(100) NOT NULL DEFAULT '' COMMENT '이전 단계 이름 스냅샷',
  to_name_snapshot    VARCHAR(100) NOT NULL DEFAULT '' COMMENT '이동 단계 이름 스냅샷',
  effective_local     DATETIME NOT NULL COMMENT '업무상 발생 일시(한국 기준)',
  time_unknown        TINYINT(1) NOT NULL DEFAULT 0 COMMENT '시각 미상 표시(1이면 effective_local의 시각은 의미 없음)',
  baseline            TINYINT(1) NOT NULL DEFAULT 0 COMMENT '최초 확인(baseline) 기록 여부',
  recorded_at         DATETIME(3) NOT NULL COMMENT '시스템 기록 시각(UTC)',
  actor_user_id       VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '처리 사용자 ID',
  actor_name          VARCHAR(100) NOT NULL DEFAULT '' COMMENT '처리자 이름 스냅샷',
  reason              VARCHAR(500) NOT NULL DEFAULT '' COMMENT '사유',
  region_name         VARCHAR(100) NOT NULL DEFAULT '' COMMENT '당시 구역 스냅샷',
  class_name          VARCHAR(100) NOT NULL DEFAULT '' COMMENT '당시 반 스냅샷',
  worker_name         VARCHAR(100) NOT NULL DEFAULT '' COMMENT '당시 담당자 이름 스냅샷',
  member_id           VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '당시 활동자 ID(명부에서 사라지면 NULL)',
  worker_code         VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' COMMENT '당시 활동자 코드 스냅샷',
  employment_text     VARCHAR(200) NOT NULL DEFAULT '' COMMENT '당시 직업 스냅샷',
  PRIMARY KEY (id),
  UNIQUE KEY uq_person_stage_events_seq (person_id, sequence_no),
  KEY ix_person_stage_events_person_time (person_id, effective_local),
  KEY ix_person_stage_events_to_time (to_stage_id, effective_local),
  KEY ix_person_stage_events_region_time (region_name, effective_local),
  KEY ix_person_stage_events_from (from_stage_id),
  KEY ix_person_stage_events_actor (actor_user_id),
  KEY ix_person_stage_events_member (member_id),
  CONSTRAINT fk_person_stage_events_person FOREIGN KEY (person_id) REFERENCES people (id),
  CONSTRAINT fk_person_stage_events_from FOREIGN KEY (from_stage_id) REFERENCES stages (id),
  CONSTRAINT fk_person_stage_events_to FOREIGN KEY (to_stage_id) REFERENCES stages (id),
  CONSTRAINT fk_person_stage_events_actor FOREIGN KEY (actor_user_id) REFERENCES app_users (id) ON DELETE SET NULL,
  CONSTRAINT fk_person_stage_events_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE SET NULL,
  CONSTRAINT ck_person_stage_events_seq CHECK (sequence_no >= 1),
  CONSTRAINT ck_person_stage_events_flags CHECK (time_unknown IN (0, 1) AND baseline IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='대상자 단계 이동 이력(삭제·연쇄삭제 없이 보존)';

-- 사용자가 명시 입력한 단계일. 단계 이동 이력과 같은 자료가 아니다.
CREATE TABLE person_stage_dates (
  person_id      VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '대상자 ID',
  milestone_key  VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '단계일 키',
  stage_id       VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '대응 단계 ID(없으면 NULL)',
  reached_date   DATE NOT NULL COMMENT '단계 도달일(한국 기준)',
  updated_at     DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (person_id, milestone_key),
  KEY ix_person_stage_dates_stage (stage_id),
  KEY ix_person_stage_dates_key_date (milestone_key, reached_date),
  CONSTRAINT fk_person_stage_dates_person FOREIGN KEY (person_id) REFERENCES people (id),
  CONSTRAINT fk_person_stage_dates_stage FOREIGN KEY (stage_id) REFERENCES stages (id),
  CONSTRAINT ck_person_stage_dates_key CHECK (milestone_key IN (
    'manpikDate', 'findADate', 'habBDate', 'habADate',
    'youngTtaDate', 'bokshinDate', 'cardReceivedDate', 'centerRegisteredDate'
  ))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='명시 입력 단계일';

CREATE TABLE person_status_events (
  id               VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '상태 이력 ID',
  person_id        VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '대상자 ID',
  sequence_no      INT UNSIGNED NOT NULL COMMENT '대상자별 이력 순번',
  from_status      VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '이전 상태(최초 기록은 NULL)',
  to_status        VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '변경 상태(active/dropped)',
  effective_local  DATETIME NOT NULL COMMENT '업무상 발생 일시(한국 기준)',
  recorded_at      DATETIME(3) NOT NULL COMMENT '시스템 기록 시각(UTC)',
  actor_user_id    VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '처리 사용자 ID',
  actor_name       VARCHAR(100) NOT NULL DEFAULT '' COMMENT '처리자 이름 스냅샷',
  reason           VARCHAR(500) NOT NULL DEFAULT '' COMMENT '사유',
  region_name      VARCHAR(100) NOT NULL DEFAULT '' COMMENT '당시 구역 스냅샷',
  PRIMARY KEY (id),
  UNIQUE KEY uq_person_status_events_seq (person_id, sequence_no),
  KEY ix_person_status_events_person_time (person_id, effective_local),
  KEY ix_person_status_events_region_time (region_name, effective_local),
  KEY ix_person_status_events_actor (actor_user_id),
  CONSTRAINT fk_person_status_events_person FOREIGN KEY (person_id) REFERENCES people (id),
  CONSTRAINT fk_person_status_events_actor FOREIGN KEY (actor_user_id) REFERENCES app_users (id) ON DELETE SET NULL,
  CONSTRAINT ck_person_status_events_seq CHECK (sequence_no >= 1),
  CONSTRAINT ck_person_status_events_status CHECK (
    to_status IN ('active', 'dropped') AND (from_status IS NULL OR from_status IN ('active', 'dropped'))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='대상자 탈락·복귀 이력';

-- ---------------------------------------------------------------------
-- 5. 활동·일보·목표
-- ---------------------------------------------------------------------

-- person_id가 있으면 대상자 활동, 없으면 독립 활동. 사본을 중복 저장하지 않는다.
CREATE TABLE activity_records (
  id                    VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '활동 기록 ID',
  code                  VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '활동 코드(정확 비교)',
  person_id             VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '대상자 ID(독립 활동은 NULL)',
  activity_date         DATE NOT NULL COMMENT '활동 날짜(한국 기준)',
  start_time            TIME NULL COMMENT '시작 시각(미입력 NULL)',
  end_time              TIME NULL COMMENT '종료 시각(미입력 NULL, 자정 넘김 가능하여 start 이후 강제 안 함)',
  duration_minutes      INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '활동 시간(분)',
  classification2       VARCHAR(60) NOT NULL DEFAULT '' COMMENT '분류2',
  session_key           VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT '참여 회차 그룹 식별자(UNIQUE 아님)',
  member_id             VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '활동자 ID(명부에서 사라지면 NULL)',
  worker_code           VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' COMMENT '활동자 코드 스냅샷(UUID가 아닌 기존 code 가능)',
  worker_name_snapshot  VARCHAR(100) NOT NULL DEFAULT '' COMMENT '활동자 이름 스냅샷',
  region_name           VARCHAR(100) NOT NULL DEFAULT '' COMMENT '구역 표기 스냅샷',
  area_id_snapshot      VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' COMMENT '구역 조직 ID 스냅샷(FK 아님)',
  area_name_snapshot    VARCHAR(100) NOT NULL DEFAULT '' COMMENT '구역 이름 스냅샷',
  unit_path_snapshot    VARCHAR(500) NOT NULL DEFAULT '' COMMENT '조직 경로 스냅샷',
  class_name            VARCHAR(100) NOT NULL DEFAULT '' COMMENT '반 스냅샷',
  place                 VARCHAR(200) NOT NULL DEFAULT '' COMMENT '장소',
  activity_kind         VARCHAR(100) NOT NULL DEFAULT '' COMMENT '활동 종류',
  notes                 TEXT NULL COMMENT '비고',
  created_at            DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at            DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_activity_records_code (code),
  KEY ix_activity_records_member_date (member_id, activity_date),
  KEY ix_activity_records_region_date (region_name, activity_date),
  KEY ix_activity_records_person_date (person_id, activity_date),
  KEY ix_activity_records_session (session_key),
  CONSTRAINT fk_activity_records_person FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE SET NULL,
  CONSTRAINT fk_activity_records_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE SET NULL,
  CONSTRAINT ck_activity_records_duration CHECK (duration_minutes <= 1440)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='독립 활동과 대상자별 활동';

CREATE TABLE regional_activity_records (
  id                   VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '지역활동 기록 ID',
  member_id            VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '현재 명부의 활동자 ID(연결 가능한 경우만)',
  source_namespace     VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '원본 출처 구분',
  source_member_id     VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '원본 활동자 ID(정확 비교, 명부에 없어도 보존)',
  record_month         CHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '기록 월(YYYY-MM)',
  record_date          DATE NULL COMMENT '기록 일(월 단위 기록은 NULL, 임의 일자로 바꾸지 않음)',
  period_key           VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '기간 키(일 단위 YYYY-MM-DD, 월 단위 YYYY-MM)',
  activity_code        TINYINT UNSIGNED NOT NULL COMMENT '활동 구분(1~4: 적극/후원/소극/비활동)',
  name_snapshot        VARCHAR(100) NOT NULL DEFAULT '' COMMENT '이름 스냅샷',
  member_code_snapshot VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' COMMENT '활동자 코드 스냅샷',
  region_name          VARCHAR(100) NOT NULL DEFAULT '' COMMENT '구역 스냅샷',
  created_at           DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at           DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_regional_activity_source_period (source_namespace, source_member_id, period_key),
  KEY ix_regional_activity_region_date (region_name, record_date),
  KEY ix_regional_activity_member_month (member_id, record_month),
  CONSTRAINT fk_regional_activity_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE SET NULL,
  CONSTRAINT ck_regional_activity_code CHECK (activity_code BETWEEN 1 AND 4),
  CONSTRAINT ck_regional_activity_month CHECK (record_month REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- 월/일 구분과 record_month, record_date, period_key 일치
  CONSTRAINT ck_regional_activity_period CHECK (
    (record_date IS NULL AND period_key = record_month)
    OR (
      record_date IS NOT NULL
      AND period_key = DATE_FORMAT(record_date, '%Y-%m-%d')
      AND record_month = DATE_FORMAT(record_date, '%Y-%m')
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='구성원별 적극/후원/소극/비활동 기록(월·일 단위)';

-- 상세 없이 구역 합계만 있는 일계. 상세 찾기 실적과 무조건 합산하지 않는다(앱 집계 정책).
CREATE TABLE daily_area_reports (
  id             VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '구역 일계 ID',
  region_name    VARCHAR(100) NOT NULL COMMENT '구역 표기',
  report_date    DATE NOT NULL COMMENT '보고일',
  found_count    INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '찾기 수',
  advanced_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '진전(유지) 수',
  dropped_count  INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '탈락 수',
  created_at     DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at     DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_daily_area_reports_region_date (region_name, report_date),
  CONSTRAINT ck_daily_area_reports_region CHECK (CHAR_LENGTH(TRIM(region_name)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='구역 일계(합계만 있는 일보)';

CREATE TABLE daily_finding_reports (
  id                    VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '일보 상세 ID',
  report_date           DATE NOT NULL COMMENT '보고일(실제 찾은 날짜와 구분)',
  person_id             VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '연결된 대상자 ID(삭제되면 NULL)',
  person_code_snapshot  VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '대상자 코드 스냅샷(보고일과 함께 유일)',
  name                  VARCHAR(100) NOT NULL COMMENT '이름 스냅샷',
  found_date            DATE NULL COMMENT '찾은 날짜(미입력 NULL)',
  date_unknown          TINYINT(1) NOT NULL DEFAULT 0 COMMENT '날짜 미상 표시',
  found_time            TIME NULL COMMENT '찾은 시각(미입력 NULL)',
  stage_id              VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '단계 ID',
  report_status         VARCHAR(10) NOT NULL COMMENT '보고 구분(신규/유지/탈락)',
  member_id             VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '활동자 ID(명부에서 사라지면 NULL)',
  source_member_id      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' COMMENT '원본 활동자 ID',
  member_code_snapshot  VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' COMMENT '활동자 코드 스냅샷',
  worker_name_snapshot  VARCHAR(100) NOT NULL DEFAULT '' COMMENT '담당자 이름 스냅샷',
  region_name           VARCHAR(100) NOT NULL DEFAULT '' COMMENT '구역 스냅샷',
  class_name            VARCHAR(100) NOT NULL DEFAULT '' COMMENT '반 스냅샷',
  unit_path_snapshot    VARCHAR(500) NOT NULL DEFAULT '' COMMENT '조직 경로 스냅샷',
  gender                VARCHAR(20) NOT NULL DEFAULT '' COMMENT '성별',
  age                   SMALLINT UNSIGNED NULL COMMENT '나이(0~120, 미입력 NULL)',
  tool                  VARCHAR(200) NOT NULL DEFAULT '' COMMENT '도구',
  residence             VARCHAR(200) NOT NULL DEFAULT '' COMMENT '거주지',
  place                 VARCHAR(200) NOT NULL DEFAULT '' COMMENT '장소',
  classification1       VARCHAR(60) NOT NULL DEFAULT '' COMMENT '분류1',
  classification2       VARCHAR(60) NOT NULL DEFAULT '' COMMENT '분류2',
  teacher_name          VARCHAR(100) NOT NULL DEFAULT '' COMMENT '교사 이름',
  reason                VARCHAR(500) NOT NULL DEFAULT '' COMMENT '사유',
  created_at            DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at            DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_daily_finding_reports_date_code (report_date, person_code_snapshot),
  KEY ix_daily_finding_reports_region_date (region_name, report_date),
  KEY ix_daily_finding_reports_member_date (member_id, report_date),
  KEY ix_daily_finding_reports_person (person_id),
  KEY ix_daily_finding_reports_stage (stage_id),
  CONSTRAINT fk_daily_finding_reports_person FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE SET NULL,
  CONSTRAINT fk_daily_finding_reports_stage FOREIGN KEY (stage_id) REFERENCES stages (id),
  CONSTRAINT fk_daily_finding_reports_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE SET NULL,
  CONSTRAINT ck_daily_finding_reports_status CHECK (report_status IN ('신규', '유지', '탈락')),
  CONSTRAINT ck_daily_finding_reports_age CHECK (age IS NULL OR age BETWEEN 0 AND 120),
  CONSTRAINT ck_daily_finding_reports_date_unknown CHECK (date_unknown IN (0, 1) AND (date_unknown = 0 OR found_date IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='보고일별 찾기·유지·탈락 상세';

-- 구역·반의 기간별 목표. 전체 단계는 stage_id NULL + stage_scope_key='*'.
-- NULL은 UNIQUE에서 중복을 허용하므로 NOT NULL인 stage_scope_key를 UNIQUE에 넣는다.
CREATE TABLE goals (
  id               VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '목표 ID',
  region_name      VARCHAR(100) NOT NULL DEFAULT '' COMMENT '구역(미선택은 빈 문자열)',
  class_name       VARCHAR(100) NOT NULL DEFAULT '' COMMENT '반(미선택은 빈 문자열)',
  org_unit_id      VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '연결 조직 ID(선택)',
  date_from        DATE NOT NULL COMMENT '시작일',
  date_to          DATE NOT NULL COMMENT '종료일',
  stage_id         VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '대상 단계 ID(전체 단계는 NULL)',
  stage_scope_key  VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '단계 범위 키(전체 단계 *, 아니면 stage_id와 동일)',
  period_unit      VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '기간 단위(week/month/custom)',
  target_count     INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '목표 수(0 허용)',
  created_at       DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at       DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_goals_scope (region_name, class_name, date_from, date_to, stage_scope_key),
  KEY ix_goals_period (date_from, date_to),
  KEY ix_goals_org_unit (org_unit_id),
  KEY ix_goals_stage (stage_id),
  CONSTRAINT fk_goals_org_unit FOREIGN KEY (org_unit_id) REFERENCES org_units (id) ON DELETE SET NULL,
  CONSTRAINT fk_goals_stage FOREIGN KEY (stage_id) REFERENCES stages (id),
  CONSTRAINT ck_goals_period CHECK (date_from <= date_to),
  CONSTRAINT ck_goals_unit CHECK (period_unit IN ('week', 'month', 'custom')),
  CONSTRAINT ck_goals_scope CHECK (region_name <> '' OR class_name <> ''),
  CONSTRAINT ck_goals_stage_scope CHECK (
    (stage_id IS NULL AND stage_scope_key = '*')
    OR (stage_id IS NOT NULL AND stage_scope_key = stage_id)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='구역·반 기간별 목표';

-- ---------------------------------------------------------------------
-- 6. 콜링·소셜링
-- ---------------------------------------------------------------------

CREATE TABLE calling_records (
  id                         VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '콜링 기록 ID',
  person_id                  VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '대상자 ID(미연결 MIG 자료는 NULL)',
  person_name_snapshot       VARCHAR(100) NOT NULL DEFAULT '' COMMENT '대상자 이름 스냅샷',
  person_code_snapshot       VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' COMMENT '대상자 코드 스냅샷',
  introducer_name_snapshot   VARCHAR(100) NOT NULL DEFAULT '' COMMENT '인도자 이름 스냅샷',
  area_name                  VARCHAR(100) NOT NULL DEFAULT '' COMMENT '구역 이름',
  finding_date               DATE NULL COMMENT '찾은 날짜(미입력 NULL)',
  call_date                  DATE NOT NULL COMMENT '통화 날짜',
  call_time                  TIME NULL COMMENT '통화 시각(미입력 NULL)',
  caller_name                VARCHAR(100) NOT NULL DEFAULT '' COMMENT '통화자 이름',
  round_number               TINYINT UNSIGNED NOT NULL COMMENT '숫자 회차(0~5)',
  round_name                 VARCHAR(60) NULL COMMENT '사용자 회차명(예: 수능인원/5차, 최대 60자)',
  result                     VARCHAR(10) NOT NULL COMMENT '결과(만픽/부재/재통화/거절/기타)',
  original_result            VARCHAR(100) NULL COMMENT "기타일 때 원본 결과 표기(reported_result와 동시 입력 금지)",
  reported_result            VARCHAR(100) NULL COMMENT '보고용 결과 표기(original_result와 동시 입력 금지)',
  notes                      TEXT NULL COMMENT '특이사항(최대 5000자, 중복 판정에 포함하지 않음)',
  attempt_key_hash           CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '통화 시도 키 SHA-256(소문자 16진). 계산은 앱이 기존 calling.cjs 규칙으로 수행',
  source_import_job_id       VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '가져온 작업 ID(직접 입력은 NULL)',
  created_at                 DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at                 DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_calling_records_attempt (attempt_key_hash),
  KEY ix_calling_records_date_caller (call_date, caller_name),
  KEY ix_calling_records_person_date (person_id, call_date),
  KEY ix_calling_records_area_date (area_name, call_date),
  KEY ix_calling_records_round_date (round_number, call_date),
  KEY ix_calling_records_import (source_import_job_id),
  CONSTRAINT fk_calling_records_person FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE SET NULL,
  CONSTRAINT fk_calling_records_import FOREIGN KEY (source_import_job_id) REFERENCES import_jobs (id),
  CONSTRAINT ck_calling_records_round CHECK (round_number BETWEEN 0 AND 5),
  CONSTRAINT ck_calling_records_round_name CHECK (round_name IS NULL OR CHAR_LENGTH(round_name) <= 60),
  CONSTRAINT ck_calling_records_result CHECK (result IN ('만픽', '부재', '재통화', '거절', '기타')),
  CONSTRAINT ck_calling_records_notes CHECK (notes IS NULL OR CHAR_LENGTH(notes) <= 5000),
  CONSTRAINT ck_calling_records_result_pair CHECK (original_result IS NULL OR reported_result IS NULL),
  CONSTRAINT ck_calling_records_hash CHECK (attempt_key_hash REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='대상자별 통화 시도';

CREATE TABLE socialing_programs (
  id                    VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '소셜링 모임 ID',
  name                  VARCHAR(100) NOT NULL COMMENT '모임 이름',
  normalized_name_key   VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '정규화 이름 키(앱이 NFKC/공백 규칙으로 계산, 정확 비교)',
  aliases_json          JSON NULL COMMENT '별칭 배열(JSON)',
  active                TINYINT(1) NOT NULL DEFAULT 1 COMMENT '사용 여부',
  created_at            DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at            DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_socialing_programs_key (normalized_name_key),
  KEY ix_socialing_programs_name (name),
  CONSTRAINT ck_socialing_programs_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='소셜링 모임 사전';

-- pending → converted는 같은 행의 상태 전환이다.
CREATE TABLE socialing_intakes (
  id                    VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '소셜링 유입 ID',
  program_id            VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '소셜링 모임 ID',
  intake_date           DATE NULL COMMENT '유입일(옛 person.socialing 자료는 공란 가능, pending은 필수)',
  name                  VARCHAR(100) NOT NULL COMMENT '이름',
  region_name           VARCHAR(100) NOT NULL DEFAULT '' COMMENT '구역',
  introducer_member_id  VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '인도자 활동자 ID',
  notes                 TEXT NULL COMMENT '비고',
  person_id             VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '전환된 대상자 ID(converted에서 필수, 한 대상자에 한 유입)',
  status                VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending' COMMENT '상태(pending/converted)',
  converted_at          DATETIME(3) NULL COMMENT '전환 시각(UTC, 옛 자료는 NULL 가능)',
  created_at            DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  updated_at            DATETIME(3) NOT NULL COMMENT '수정 시각(UTC)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_socialing_intakes_person (person_id),
  KEY ix_socialing_intakes_program_date (program_id, intake_date),
  KEY ix_socialing_intakes_status_date (status, intake_date),
  KEY ix_socialing_intakes_introducer (introducer_member_id),
  CONSTRAINT fk_socialing_intakes_program FOREIGN KEY (program_id) REFERENCES socialing_programs (id),
  CONSTRAINT fk_socialing_intakes_introducer FOREIGN KEY (introducer_member_id) REFERENCES members (id) ON DELETE SET NULL,
  CONSTRAINT fk_socialing_intakes_person FOREIGN KEY (person_id) REFERENCES people (id),
  CONSTRAINT ck_socialing_intakes_status CHECK (
    (status = 'pending' AND intake_date IS NOT NULL AND person_id IS NULL AND converted_at IS NULL)
    OR (status = 'converted' AND person_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='소셜링 외부유입과 대상자 전환 연결';

-- ---------------------------------------------------------------------
-- 7. 이력·가져오기·이관 추적
-- ---------------------------------------------------------------------

-- before_json/after_json에는 마스킹된 내용만 저장한다. 연락처 원문·암호문·키·토큰 금지.
-- 대상은 삭제된 항목이나 설정 키일 수 있어 target_id에 FK를 두지 않는다.
CREATE TABLE audit_logs (
  id                    VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '감사 로그 ID',
  chain_key             VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '해시 사슬 식별자(출처·세대별)',
  sequence_no           BIGINT UNSIGNED NOT NULL COMMENT '사슬 내 순번',
  at_utc                DATETIME(3) NOT NULL COMMENT '발생 시각(UTC)',
  actor_user_id         VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '수행 사용자 ID',
  actor_name            VARCHAR(100) NOT NULL DEFAULT '' COMMENT '수행자 이름 스냅샷',
  action_name           VARCHAR(100) NOT NULL COMMENT '동작 이름',
  target_type           VARCHAR(60) NOT NULL COMMENT '대상 종류',
  target_id             VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' COMMENT '대상 ID(FK 아님, 정확 비교)',
  before_json           JSON NULL COMMENT '변경 전(마스킹된 내용만)',
  after_json            JSON NULL COMMENT '변경 후(마스킹된 내용만)',
  previous_hash         CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '이전 항목 해시(사슬 첫 항목은 NULL)',
  entry_hash            CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '이 항목 해시',
  source_import_job_id  VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '이관 작업 ID(웹에서 발생한 이력은 NULL)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_logs_chain_seq (chain_key, sequence_no),
  KEY ix_audit_logs_target (target_type, target_id, at_utc),
  KEY ix_audit_logs_actor (actor_user_id, at_utc),
  KEY ix_audit_logs_import (source_import_job_id),
  CONSTRAINT fk_audit_logs_actor FOREIGN KEY (actor_user_id) REFERENCES app_users (id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_logs_import FOREIGN KEY (source_import_job_id) REFERENCES import_jobs (id),
  CONSTRAINT ck_audit_logs_hash CHECK (
    entry_hash REGEXP '^[0-9a-f]{64}$' AND (previous_hash IS NULL OR previous_hash REGEXP '^[0-9a-f]{64}$')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='업무 변경 이력(마스킹된 내용, 해시 사슬)';

CREATE TABLE import_rows (
  id                  VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '가져오기 행 ID',
  job_id              VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '가져오기 작업 ID',
  sheet_name          VARCHAR(100) NOT NULL DEFAULT '' COMMENT '시트 이름',
  `row_number`        INT UNSIGNED NOT NULL COMMENT '원본 행 번호',
  entity_type         VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '대상 종류',
  source_record_key   VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT '원본 레코드 키(정확 비교, 연락처 등 개인정보 금지)',
  target_id           VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT '반영된 웹 ID(FK 아님)',
  row_sha256          CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '원본 행 SHA-256(행 본문은 저장하지 않음)',
  status              VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '처리 결과(inserted/updated/skipped/error)',
  error_code          VARCHAR(60) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '오류 코드',
  sanitized_message   VARCHAR(500) NULL COMMENT '개인정보를 제거한 메시지',
  PRIMARY KEY (id),
  UNIQUE KEY uq_import_rows_position (job_id, sheet_name, `row_number`),
  KEY ix_import_rows_status (job_id, status),
  KEY ix_import_rows_entity_target (entity_type, target_id),
  CONSTRAINT fk_import_rows_job FOREIGN KEY (job_id) REFERENCES import_jobs (id),
  CONSTRAINT ck_import_rows_status CHECK (status IN ('inserted', 'updated', 'skipped', 'error')),
  CONSTRAINT ck_import_rows_sha CHECK (row_sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='가져오기 행별 처리 결과';

-- 원본 키는 한글·대소문자 구분이 있어 utf8mb4_bin으로 보존한다.
-- 복합 PK 길이: (80+40+80+100) x 4바이트 = 1,200바이트(InnoDB 한도 3,072 이내).
CREATE TABLE legacy_id_map (
  source_namespace     VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '원본 출처 구분',
  entity_type          VARCHAR(40)  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '원본 자료 종류',
  source_parent_key    VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' COMMENT '원본 상위 키(없으면 빈 문자열)',
  source_id            VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '원본 ID(한글 단계 ID 등 원문 보존)',
  target_id            VARCHAR(80)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '웹 ID',
  source_import_job_id VARCHAR(80)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '대응을 만든 가져오기 작업 ID',
  source_row_sha256    CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '원본 행 SHA-256',
  created_at           DATETIME(3) NOT NULL COMMENT '생성 시각(UTC)',
  PRIMARY KEY (source_namespace, entity_type, source_parent_key, source_id),
  KEY ix_legacy_id_map_target (entity_type, target_id),
  KEY ix_legacy_id_map_job (source_import_job_id),
  CONSTRAINT fk_legacy_id_map_job FOREIGN KEY (source_import_job_id) REFERENCES import_jobs (id),
  CONSTRAINT ck_legacy_id_map_sha CHECK (source_row_sha256 IS NULL OR source_row_sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='원본 ID와 웹 ID 대응(재실행 중복 방지)';

-- ---------------------------------------------------------------------
-- 8. 순환 참조 해결: 조직 책임자 FK (members 생성 후 추가)
-- ---------------------------------------------------------------------
-- 이관 시에는 책임자를 NULL로 넣고, 구성원 적재 후 연결한다.
-- 책임자의 소속 적합성은 앱의 조직 검증을 따른다.
ALTER TABLE org_units
  ADD CONSTRAINT fk_org_units_leader FOREIGN KEY (leader_member_id) REFERENCES members (id) ON DELETE SET NULL;
