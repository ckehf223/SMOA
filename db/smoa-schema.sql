-- =====================================================================
-- SMOA 전체 단순 스키마 (신규 DB 적용용 검토 파일)
--
-- [적용 범위]
--  * "에이전트가 DB에 적용하지 않음"은 이 DDL을 작성한 세션의 범위일 뿐이다.
--    사용자 전체 승인은 백업 후 실제 적용까지 포함한다.
--  * 기존 smoa 서버에 이미 있는 7개 테이블(ORGMSTR, ORGDTL, PSMSTR, PGMMSTR, AUTHMSTR,
--    AUTHDTL, AUTHORG)과 같은 이름은 이 파일 그대로 CREATE 실행 금지.
--    해당 7개는 실제 구조 대조 후 별도 증분(ALTER) DDL로 처리한다.
--  * 기존 서버의 FK(AUTHDTL: FK_AUTHDTL_AUTHMSTR, FK_AUTHDTL_PGMMSTR /
--    AUTHORG: FK_AUTHORG_AUTHMSTR, FK_AUTHORG_ORGDTL, FK_AUTHORG_ORGMSTR)는 존재 확인됨.
--    이 DDL은 FK 금지를 유지하며, 위 FK는 마이그레이션에서 제거 예정이다.
--  * ORGMSTR/ORGDTL은 전역 업무 조직이다. 자료실별 원본 조직ID는 MIGMAP(SOURCE_ID)에 보존한다.
--    현재 실제 이관 대상은 3개 지역뿐이며 다른 자료실은 미이관이다.
--  * PSMSTR.EMPL_ID는 varchar(60) PK로 설계했으나 실제 서버는 비어 있는 bigint이다(후속 별도 ALTER 예정).
--
-- [원칙]
--  * FOREIGN KEY 선언 없음. ID는 참조값일 뿐이며 정합성은 Service 트랜잭션에서 검증한다.
--  * PK / UK / 일반 INDEX 만 사용. CHECK 는 단순 범위/YN 만 사용.
--  * ENGINE=InnoDB, utf8mb4_general_ci. 해시/키성 컬럼만 ascii_bin.
--  * DROP / TRUNCATE / INSERT / 기존 테이블 ALTER 없음. IF NOT EXISTS 없음
--    (이미 존재하면 오류로 드러나야 한다 — 실제 스키마와의 차이는 별도 검토).
--  * 대상 스키마는 접속 시점에 선택되어 있다 (USE/CREATE DATABASE 없음).
--  * SYS_* 는 서버(Service)가 채운다. 수정시각 ON UPDATE 자동 갱신 없음.
--  * lower_case_table_names: 마지막 확인값 0, 사용자 목표 1. 이 DDL은 서버 설정을
--    바꾸지 않는다(OS 설정/재기동 필요할 수 있음). 이름은 모두 대문자로 일관 사용한다.
--  * 연락처 평문 컬럼 없음. PHONE_ENC(AES-GCM 봉투) + PHONE_LAST4 만 저장. 키는 DB/소스 밖.
--
-- 생성 순서:
--  ORGMSTR -> ORGDTL -> PSMSTR -> PGMMSTR -> AUTHMSTR -> AUTHDTL -> AUTHORG -> USERMSTR
--  -> LIBMSTR -> CODEMSTR -> CODEDTL -> TGMSTR -> TGSTGLOG -> TGSTATLOG -> ACTMSTR
--  -> ORGACT -> CALLMSTR -> SOCMSTR -> SOCDTL -> DAYMSTR -> DAYDTL -> GOALMSTR
--  -> SYSCFG -> CHGLOG -> MIGJOB -> MIGMAP
-- (FK가 없어 순서는 강제되지 않지만 읽기 쉬운 의존 순서로 둔다.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 조직/명부
-- ---------------------------------------------------------------------
CREATE TABLE `ORGMSTR` (
  `ORG_MSTR_CODE` varchar(60) NOT NULL COMMENT '지역코드',
  `ORG_MSTR_NAME_HAN` varchar(60) NOT NULL COMMENT '지역명',
  `SORT_NO` int NOT NULL DEFAULT 0 COMMENT '정렬순서',
  `USE_IND` varchar(1) DEFAULT 'N' COMMENT '사용여부(Y/N, 실제 원형: nullable default N)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_ORGMSTR` PRIMARY KEY (`ORG_MSTR_CODE`),
  CONSTRAINT `CK_ORGMSTR_USE_IND` CHECK (`USE_IND` IN ('Y','N'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='지역 마스터';

CREATE TABLE `ORGDTL` (
  `ORG_MSTR_CODE` varchar(60) NOT NULL COMMENT '지역코드',
  `ORG_CODE` varchar(60) NOT NULL COMMENT '구역코드',
  `ORG_NAME_HAN` varchar(60) NOT NULL COMMENT '구역명',
  `SORT_NO` int NOT NULL DEFAULT 0 COMMENT '정렬순서',
  `USE_IND` varchar(1) DEFAULT 'N' COMMENT '사용여부(Y/N, 실제 원형: nullable default N)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_ORGDTL` PRIMARY KEY (`ORG_MSTR_CODE`, `ORG_CODE`),
  CONSTRAINT `CK_ORGDTL_USE_IND` CHECK (`USE_IND` IN ('Y','N'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='구역 상세(복합키: 지역+구역)';

CREATE TABLE `PSMSTR` (
  `EMPL_ID` varchar(60) NOT NULL COMMENT '조직원ID',
  `EMPL_CODE` varchar(60) DEFAULT NULL COMMENT '조직원 표기코드(구성원ID)',
  `ORG_MSTR_CODE` varchar(60) DEFAULT NULL COMMENT '지역코드(지역+구역 소속 구별용, 미소속은 NULL)',
  `ORG_CODE` varchar(60) DEFAULT NULL COMMENT '구역코드',
  `EMPL_NAME_HAN` varchar(60) NOT NULL COMMENT '이름',
  `TITLE_CODE` varchar(60) DEFAULT NULL COMMENT '직책',
  `BAN_CODE` varchar(60) DEFAULT NULL COMMENT '반',
  `JOB_CODE` varchar(20) DEFAULT '0' COMMENT '직업구분',
  `STATUS_CODE` varchar(20) DEFAULT '2' COMMENT '상태',
  `USE_IND` varchar(1) NOT NULL DEFAULT 'Y' COMMENT '사용여부(Y/N)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_PSMSTR` PRIMARY KEY (`EMPL_ID`),
  KEY `IX_PSMSTR_ORG` (`ORG_MSTR_CODE`, `ORG_CODE`),
  KEY `IX_PSMSTR_EMPL_CODE` (`EMPL_CODE`),
  KEY `IX_PSMSTR_NAME` (`EMPL_NAME_HAN`),
  CONSTRAINT `CK_PSMSTR_USE_IND` CHECK (`USE_IND` IN ('Y','N'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='조직원 명부(이름 중복 허용, EMPL_ID 로만 식별)';

-- ---------------------------------------------------------------------
-- 2. 권한 (FK 없음, 계정당 패키지 하나)
-- ---------------------------------------------------------------------
CREATE TABLE `PGMMSTR` (
  `PGM_ID` varchar(60) NOT NULL COMMENT '고유프로그램ID(불변)',
  `PGM_NAME_HAN` varchar(100) NOT NULL COMMENT '프로그램명',
  `PGM_URL` varchar(300) DEFAULT NULL COMMENT '페이지경로(미정은 NULL)',
  `GROUP_NAME` varchar(100) DEFAULT NULL COMMENT '메뉴그룹명',
  `MODULE_ID` varchar(60) DEFAULT NULL COMMENT '처리 모듈 키(NULL 이면 서버 기본 카탈로그, 001-web-persistence.sql)',
  `CATEGORY_CODE` varchar(20) DEFAULT NULL COMMENT '분류 BUSINESS/ADMIN(NULL 이면 서버 기본 카탈로그, 001-web-persistence.sql)',
  `PGM_SORT_NO` int NOT NULL DEFAULT 0 COMMENT '메뉴정렬순서',
  `SUPER_ADMIN_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '총관리자 전용(Y/N)',
  `READ_USE_IND` varchar(1) NOT NULL DEFAULT 'Y' COMMENT '읽기동작 지원(Y/N)',
  `WRITE_USE_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '편집동작 지원(Y/N)',
  `EXPORT_USE_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '내보내기동작 지원(Y/N)',
  `USE_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '사용여부(Y/N)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_PGMMSTR` PRIMARY KEY (`PGM_ID`),
  CONSTRAINT `UK_PGMMSTR_PGM_URL` UNIQUE (`PGM_URL`),
  CONSTRAINT `CK_PGMMSTR_SUPER_IND` CHECK (`SUPER_ADMIN_IND` IN ('Y','N')),
  CONSTRAINT `CK_PGMMSTR_READ_USE` CHECK (`READ_USE_IND` IN ('Y','N')),
  CONSTRAINT `CK_PGMMSTR_WRITE_USE` CHECK (`WRITE_USE_IND` IN ('Y','N')),
  CONSTRAINT `CK_PGMMSTR_EXPORT_USE` CHECK (`EXPORT_USE_IND` IN ('Y','N')),
  CONSTRAINT `CK_PGMMSTR_USE_IND` CHECK (`USE_IND` IN ('Y','N'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='프로그램(최하위 메뉴) 마스터';

CREATE TABLE `AUTHMSTR` (
  `AUTH_CODE` varchar(60) NOT NULL COMMENT '권한패키지ID',
  `AUTH_NAME_HAN` varchar(60) NOT NULL COMMENT '패키지명',
  `DATA_SCOPE_CODE` varchar(10) NOT NULL DEFAULT 'ORG' COMMENT '데이터범위(ALL=전체, ORG=AUTHORG 허용 구역)',
  `SUPER_ADMIN_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '총관리자 전용 보호속성(Y/N)',
  `USE_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '사용여부(Y/N)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_AUTHMSTR` PRIMARY KEY (`AUTH_CODE`),
  CONSTRAINT `CK_AUTHMSTR_SCOPE` CHECK (`DATA_SCOPE_CODE` IN ('ALL','ORG')),
  CONSTRAINT `CK_AUTHMSTR_SUPER_IND` CHECK (`SUPER_ADMIN_IND` IN ('Y','N')),
  CONSTRAINT `CK_AUTHMSTR_USE_IND` CHECK (`USE_IND` IN ('Y','N'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='권한 패키지 마스터';

CREATE TABLE `AUTHDTL` (
  `AUTH_CODE` varchar(60) NOT NULL COMMENT '권한패키지ID',
  `PGM_ID` varchar(60) NOT NULL COMMENT '고유프로그램ID',
  `ACCESS_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '접근권한(Y/N)',
  `READ_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '읽기권한(Y/N, 접근 필요)',
  `WRITE_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '편집권한(Y/N, 읽기 필요)',
  `EXPORT_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '내보내기권한(Y/N, 읽기 필요)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_AUTHDTL` PRIMARY KEY (`AUTH_CODE`, `PGM_ID`),
  KEY `IX_AUTHDTL_PGM_ID` (`PGM_ID`),
  CONSTRAINT `CK_AUTHDTL_ACCESS_IND` CHECK (`ACCESS_IND` IN ('Y','N')),
  CONSTRAINT `CK_AUTHDTL_READ_IND` CHECK (`READ_IND` IN ('Y','N')),
  CONSTRAINT `CK_AUTHDTL_WRITE_IND` CHECK (`WRITE_IND` IN ('Y','N')),
  CONSTRAINT `CK_AUTHDTL_EXPORT_IND` CHECK (`EXPORT_IND` IN ('Y','N')),
  CONSTRAINT `CK_AUTHDTL_READ_NEEDS_ACCESS` CHECK (`READ_IND` = 'N' OR `ACCESS_IND` = 'Y'),
  CONSTRAINT `CK_AUTHDTL_WRITE_NEEDS_READ` CHECK (`WRITE_IND` = 'N' OR `READ_IND` = 'Y'),
  CONSTRAINT `CK_AUTHDTL_EXPORT_NEEDS_READ` CHECK (`EXPORT_IND` = 'N' OR `READ_IND` = 'Y')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='패키지별 프로그램 권한(행이 없으면 거부)';

CREATE TABLE `AUTHORG` (
  `AUTH_CODE` varchar(60) NOT NULL COMMENT '권한패키지ID',
  `ORG_MSTR_CODE` varchar(60) NOT NULL COMMENT '지역코드',
  `ORG_CODE` varchar(60) NOT NULL COMMENT '구역코드',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_AUTHORG` PRIMARY KEY (`AUTH_CODE`, `ORG_MSTR_CODE`, `ORG_CODE`),
  KEY `IX_AUTHORG_ORG` (`ORG_MSTR_CODE`, `ORG_CODE`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='패키지별 허용 구역(DATA_SCOPE_CODE=ORG일 때 사용)';

CREATE TABLE `USERMSTR` (
  `USER_ID` varchar(50) NOT NULL COMMENT '내부계정ID',
  `LOGIN_ID` varchar(60) NOT NULL COMMENT '로그인ID',
  `USER_NAME_HAN` varchar(60) NOT NULL COMMENT '표시이름',
  `PASSWORD_HASH` varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '비밀번호해시(PasswordEncoder, 정확 비교)',
  `AUTH_CODE` varchar(60) NOT NULL COMMENT '권한패키지ID(한 계정 한 패키지)',
  `EMPL_ID` varchar(60) DEFAULT NULL COMMENT '조직원명부 연결(선택)',
  `USE_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '사용여부(Y/N)',
  `PWD_VERSION` bigint unsigned NOT NULL DEFAULT 1 COMMENT '비밀번호/세션무효화 버전',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_USERMSTR` PRIMARY KEY (`USER_ID`),
  CONSTRAINT `UK_USERMSTR_LOGIN_ID` UNIQUE (`LOGIN_ID`),
  KEY `IX_USERMSTR_AUTH_CODE` (`AUTH_CODE`),
  KEY `IX_USERMSTR_EMPL_ID` (`EMPL_ID`),
  CONSTRAINT `CK_USERMSTR_USE_IND` CHECK (`USE_IND` IN ('Y','N')),
  CONSTRAINT `CK_USERMSTR_PWD_HASH` CHECK (`PASSWORD_HASH` <> ''),
  CONSTRAINT `CK_USERMSTR_PWD_VERSION` CHECK (`PWD_VERSION` >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='로그인 계정(계정·패키지는 전역, 자료실과 무관)';

-- ---------------------------------------------------------------------
-- 3. 자료실 / 공통코드
-- ---------------------------------------------------------------------
CREATE TABLE `LIBMSTR` (
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID(원본/이관 구분)',
  `LIB_NAME` varchar(100) NOT NULL COMMENT '자료실명',
  `LEGACY_LIB_ID` varchar(80) DEFAULT NULL COMMENT '기존 자료실 원본ID',
  `USE_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '사용여부(Y/N)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_LIBMSTR` PRIMARY KEY (`LIB_ID`),
  KEY `IX_LIBMSTR_LEGACY` (`LEGACY_LIB_ID`),
  CONSTRAINT `CK_LIBMSTR_USE_IND` CHECK (`USE_IND` IN ('Y','N'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='자료실 마스터(구버전 여러 자료실 원본 구분용)';

CREATE TABLE `CODEMSTR` (
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID(자료실별 코드 분리)',
  `GROUP_CODE` varchar(60) NOT NULL COMMENT '코드그룹(예: STAGE, STATUS, SEX)',
  `GROUP_NAME` varchar(100) NOT NULL COMMENT '그룹명',
  `USE_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '사용여부(Y/N)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_CODEMSTR` PRIMARY KEY (`LIB_ID`, `GROUP_CODE`),
  CONSTRAINT `CK_CODEMSTR_USE_IND` CHECK (`USE_IND` IN ('Y','N'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='공통코드 그룹(자료실별. 단계는 STAGE 그룹으로 관리, 별도 단계 마스터 없음)';

CREATE TABLE `CODEDTL` (
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID(자료실별 코드 분리)',
  `GROUP_CODE` varchar(60) NOT NULL COMMENT '코드그룹',
  `ITEM_CODE` varchar(60) NOT NULL COMMENT '코드값',
  `ITEM_NAME` varchar(100) NOT NULL COMMENT '표시명',
  `SORT_NO` int NOT NULL DEFAULT 0 COMMENT '정렬순서',
  `ALIASES_JSON` longtext DEFAULT NULL COMMENT '별칭 JSON 배열(이관 원본 표기 포함)',
  `USE_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '사용여부(Y/N)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_CODEDTL` PRIMARY KEY (`LIB_ID`, `GROUP_CODE`, `ITEM_CODE`),
  CONSTRAINT `CK_CODEDTL_USE_IND` CHECK (`USE_IND` IN ('Y','N')),
  CONSTRAINT `CK_CODEDTL_ALIASES` CHECK (`ALIASES_JSON` IS NULL OR JSON_VALID(`ALIASES_JSON`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='공통코드 항목(자료실별. 자료실 간 코드 전역 병합 금지, 표기 별칭은 ALIASES_JSON)';

-- ---------------------------------------------------------------------
-- 4. 대상자
-- ---------------------------------------------------------------------
CREATE TABLE `TGMSTR` (
  `TGT_ID` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '대상자 고유키(자동증가)',
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `LEGACY_ID` varchar(80) DEFAULT NULL COMMENT '기존 원본 ID(중복 허용)',
  `TGT_CODE` varchar(60) DEFAULT NULL COMMENT '대상자 식별번호(중복 허용)',
  `TGT_NAME_HAN` varchar(100) NOT NULL COMMENT '대상자 이름(중복 허용)',
  `PHONE_ENC` text DEFAULT NULL COMMENT '연락처 AES-GCM 봉투(키버전/nonce/tag/ciphertext)',
  `PHONE_LAST4` char(4) DEFAULT NULL COMMENT '연락처 끝 네 자리',
  `PHONE_KEY_VER` varchar(20) DEFAULT NULL COMMENT '연락처 암호화 키버전',
  `SEX_CODE` varchar(20) DEFAULT NULL COMMENT '성별',
  `AGE` int DEFAULT NULL COMMENT '나이(0~120)',
  `AGE_BASE_DATE` date DEFAULT NULL COMMENT '나이 기준일',
  `FOUND_DATE` date DEFAULT NULL COMMENT '찾은 날짜(공란 NULL)',
  `FOUND_TIME` time DEFAULT NULL COMMENT '찾은 시간(공란 NULL)',
  `DATE_UNKNOWN_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '찾은날짜 미상(Y/N)',
  `CLASS1_CODE` varchar(20) DEFAULT NULL COMMENT '분류1',
  `CLASS2_CODE` varchar(20) DEFAULT NULL COMMENT '분류2',
  `PLACE_NAME` varchar(200) DEFAULT NULL COMMENT '찾은 장소',
  `TOOL_NAME` varchar(200) DEFAULT NULL COMMENT '사용 도구',
  `RESIDENCE` varchar(200) DEFAULT NULL COMMENT '거주지',
  `TEACHER_NAME` varchar(100) DEFAULT NULL COMMENT '교사',
  `REASON` varchar(2000) DEFAULT NULL COMMENT '사유',
  `WORKER_NAME` varchar(100) DEFAULT NULL COMMENT '담당자',
  `EMPL_ID` varchar(60) DEFAULT NULL COMMENT '현재 인도자 조직원ID(PSMSTR 참조, 서버검증)',
  `INTRO_EMPL_CODE` varchar(60) DEFAULT NULL COMMENT '인도자 구성원ID(연결 당시 표기)',
  `INTRO_NAME` varchar(100) DEFAULT NULL COMMENT '인도자 이름(연결 당시 표기)',
  `INTRO_ORG_SNAPSHOT` varchar(300) DEFAULT NULL COMMENT '인도자 소속(연결 당시 표기)',
  `ORG_MSTR_CODE` varchar(60) DEFAULT NULL COMMENT '현재 지역코드',
  `ORG_CODE` varchar(60) DEFAULT NULL COMMENT '현재 구역코드',
  `BAN_CODE` varchar(60) DEFAULT NULL COMMENT '반',
  `JOB_CODE` varchar(60) DEFAULT NULL COMMENT '직업 구분',
  `STAGE_CODE` varchar(60) DEFAULT NULL COMMENT '현재 단계(CODEDTL STAGE)',
  `STATUS_CODE` varchar(20) DEFAULT NULL COMMENT '현재 상태',
  `APPOINTMENT_TEXT` varchar(30) DEFAULT NULL COMMENT '확정 일정',
  `NOTES` text DEFAULT NULL COMMENT '메모',
  `CUSTOM_JSON` longtext DEFAULT NULL COMMENT '사용자 정의 항목 JSON(정의는 SYSCFG)',
  `MANPIK_DATE` date DEFAULT NULL COMMENT '만픽일',
  `FIND_A_DATE` date DEFAULT NULL COMMENT '찾A일',
  `HAB_B_DATE` date DEFAULT NULL COMMENT '합B일',
  `HAB_A_DATE` date DEFAULT NULL COMMENT '합A(육따)일',
  `YOUNG_TTA_DATE` date DEFAULT NULL COMMENT '영따일',
  `BOKSHIN_DATE` date DEFAULT NULL COMMENT '복신일',
  `CARD_RECEIVED_DATE` date DEFAULT NULL COMMENT '신카접수일',
  `CENTER_REGISTERED_DATE` date DEFAULT NULL COMMENT '센터등록일',
  `ROW_VERSION` bigint unsigned NOT NULL DEFAULT 1 COMMENT '낙관적 잠금 버전',
  `DEL_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '삭제여부(Y/N, 소프트 삭제, 001-web-persistence.sql)',
  `SOURCE_ENC` longtext DEFAULT NULL COMMENT '미분류 원본 필드 포함 암호화 원본 보존',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_TGMSTR` PRIMARY KEY (`TGT_ID`),
  KEY `IX_TGMSTR_LIB_NAME` (`LIB_ID`, `TGT_NAME_HAN`),
  KEY `IX_TGMSTR_ORG_FOUND` (`ORG_MSTR_CODE`, `ORG_CODE`, `FOUND_DATE`),
  KEY `IX_TGMSTR_EMPL` (`EMPL_ID`),
  KEY `IX_TGMSTR_STAGE_STATUS` (`STAGE_CODE`, `STATUS_CODE`),
  KEY `IX_TGMSTR_LEGACY` (`LIB_ID`, `LEGACY_ID`),
  CONSTRAINT `CK_TGMSTR_AGE` CHECK (`AGE` IS NULL OR (`AGE` >= 0 AND `AGE` <= 120)),
  CONSTRAINT `CK_TGMSTR_DATE_UNKNOWN` CHECK (`DATE_UNKNOWN_IND` IN ('Y','N')),
  CONSTRAINT `CK_TGMSTR_DEL_IND` CHECK (`DEL_IND` IN ('Y','N'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='대상자 마스터(이름/연락처/코드/LEGACY_ID UNIQUE 없음, 동일 내용도 별개 대상자)';

CREATE TABLE `TGSTGLOG` (
  `STG_LOG_ID` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '단계이력 고유키',
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `TGT_ID` bigint unsigned NOT NULL COMMENT '대상자 TGT_ID',
  `LEGACY_ID` varchar(80) DEFAULT NULL COMMENT '기존 원본 ID',
  `SEQ_NO` int NOT NULL COMMENT '대상자별 순번',
  `FROM_STAGE` varchar(60) DEFAULT NULL COMMENT '변경 전 단계',
  `TO_STAGE` varchar(60) DEFAULT NULL COMMENT '변경 후 단계',
  `FROM_NAME` varchar(100) DEFAULT NULL COMMENT '변경 전 이름',
  `TO_NAME` varchar(100) DEFAULT NULL COMMENT '변경 후 이름',
  `APPLY_DTTM` datetime DEFAULT NULL COMMENT '적용일시(한국 업무시각)',
  `RECORDED_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '기록일시(시스템 UTC)',
  `TIME_UNKNOWN_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '시각 미상(Y/N)',
  `BASELINE_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '기준(최초) 행(Y/N)',
  `ACTOR_ID` varchar(60) DEFAULT NULL COMMENT '처리자ID',
  `ACTOR_NAME` varchar(100) DEFAULT NULL COMMENT '처리자명',
  `REASON` varchar(2000) DEFAULT NULL COMMENT '사유',
  `ORG_MSTR_CODE` varchar(60) DEFAULT NULL COMMENT '당시 지역코드',
  `ORG_CODE` varchar(60) DEFAULT NULL COMMENT '당시 구역코드',
  `BAN_CODE` varchar(60) DEFAULT NULL COMMENT '당시 반',
  `WORKER_NAME` varchar(100) DEFAULT NULL COMMENT '당시 담당자',
  `EMPL_ID` varchar(60) DEFAULT NULL COMMENT '당시 인도자 조직원ID',
  `EMPL_CODE` varchar(60) DEFAULT NULL COMMENT '당시 인도자 구성원ID',
  `JOB_CODE` varchar(60) DEFAULT NULL COMMENT '당시 직업 구분',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_TGSTGLOG` PRIMARY KEY (`STG_LOG_ID`),
  CONSTRAINT `UK_TGSTGLOG_TGT_SEQ` UNIQUE (`TGT_ID`, `SEQ_NO`),
  KEY `IX_TGSTGLOG_APPLY` (`LIB_ID`, `APPLY_DTTM`),
  KEY `IX_TGSTGLOG_ORG` (`ORG_MSTR_CODE`, `ORG_CODE`),
  CONSTRAINT `CK_TGSTGLOG_TIME_UNK` CHECK (`TIME_UNKNOWN_IND` IN ('Y','N')),
  CONSTRAINT `CK_TGSTGLOG_BASELINE` CHECK (`BASELINE_IND` IN ('Y','N'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='대상자 단계 변경 이력(현재정보 갱신과 별개로 보존)';

CREATE TABLE `TGSTATLOG` (
  `STAT_LOG_ID` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '상태이력 고유키',
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `TGT_ID` bigint unsigned NOT NULL COMMENT '대상자 TGT_ID',
  `LEGACY_ID` varchar(80) DEFAULT NULL COMMENT '기존 원본 ID',
  `SEQ_NO` int NOT NULL COMMENT '대상자별 순번',
  `FROM_STATUS` varchar(20) DEFAULT NULL COMMENT '변경 전 상태',
  `TO_STATUS` varchar(20) DEFAULT NULL COMMENT '변경 후 상태',
  `APPLY_DTTM` datetime DEFAULT NULL COMMENT '적용일시(한국 업무시각)',
  `RECORDED_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '기록일시(시스템 UTC)',
  `ACTOR_ID` varchar(60) DEFAULT NULL COMMENT '처리자ID',
  `ACTOR_NAME` varchar(100) DEFAULT NULL COMMENT '처리자명',
  `REASON` varchar(2000) DEFAULT NULL COMMENT '사유',
  `ORG_MSTR_CODE` varchar(60) DEFAULT NULL COMMENT '당시 지역코드',
  `ORG_CODE` varchar(60) DEFAULT NULL COMMENT '당시 구역코드',
  `BAN_CODE` varchar(60) DEFAULT NULL COMMENT '당시 반',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_TGSTATLOG` PRIMARY KEY (`STAT_LOG_ID`),
  CONSTRAINT `UK_TGSTATLOG_TGT_SEQ` UNIQUE (`TGT_ID`, `SEQ_NO`),
  KEY `IX_TGSTATLOG_APPLY` (`LIB_ID`, `APPLY_DTTM`),
  KEY `IX_TGSTATLOG_ORG` (`ORG_MSTR_CODE`, `ORG_CODE`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='대상자 상태 변경 이력';

-- ---------------------------------------------------------------------
-- 5. 활동
-- ---------------------------------------------------------------------
CREATE TABLE `ACTMSTR` (
  `ACT_ID` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '활동 고유키',
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `LEGACY_ID` varchar(80) DEFAULT NULL COMMENT '기존 원본 ID',
  `TGT_ID` bigint unsigned DEFAULT NULL COMMENT '대상자 TGT_ID(독립 활동은 NULL)',
  `ACT_CODE` varchar(60) DEFAULT NULL COMMENT '활동 종류 코드',
  `ACT_DATE` date NOT NULL COMMENT '활동일',
  `START_TIME` time DEFAULT NULL COMMENT '시작시각',
  `END_TIME` time DEFAULT NULL COMMENT '종료시각',
  `ACT_MINUTES` int NOT NULL DEFAULT 0 COMMENT '활동 시간(분)',
  `CLASS2_CODE` varchar(20) DEFAULT NULL COMMENT '분류2',
  `SESSION_KEY` varchar(100) DEFAULT NULL COMMENT '세션 키(UNIQUE 아님)',
  `EMPL_ID` varchar(60) DEFAULT NULL COMMENT '활동자 조직원ID',
  `EMPL_CODE` varchar(60) DEFAULT NULL COMMENT '활동자 구성원ID',
  `EMPL_NAME` varchar(100) DEFAULT NULL COMMENT '활동자 이름',
  `ORG_MSTR_CODE` varchar(60) DEFAULT NULL COMMENT '지역코드',
  `ORG_CODE` varchar(60) DEFAULT NULL COMMENT '구역코드',
  `BAN_CODE` varchar(60) DEFAULT NULL COMMENT '반',
  `PLACE_NAME` varchar(200) DEFAULT NULL COMMENT '장소',
  `ACT_KIND_NAME` varchar(100) DEFAULT NULL COMMENT '활동 종류명',
  `MEMO` text DEFAULT NULL COMMENT '메모',
  `ROW_VERSION` bigint unsigned NOT NULL DEFAULT 1 COMMENT '낙관적 잠금 버전(001-web-persistence.sql)',
  `DEL_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '삭제여부(Y/N, 소프트 삭제, 001-web-persistence.sql)',
  `SOURCE_ENC` longtext DEFAULT NULL COMMENT '암호화 원본 보존(선택)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_ACTMSTR` PRIMARY KEY (`ACT_ID`),
  KEY `IX_ACTMSTR_TGT` (`TGT_ID`, `ACT_DATE`),
  KEY `IX_ACTMSTR_LIB_DATE` (`LIB_ID`, `ACT_DATE`),
  KEY `IX_ACTMSTR_EMPL` (`EMPL_ID`, `ACT_DATE`),
  KEY `IX_ACTMSTR_ORG` (`ORG_MSTR_CODE`, `ORG_CODE`),
  KEY `IX_ACTMSTR_SESSION` (`SESSION_KEY`),
  KEY `IX_ACTMSTR_LEGACY` (`LIB_ID`, `LEGACY_ID`),
  CONSTRAINT `CK_ACTMSTR_MINUTES` CHECK (`ACT_MINUTES` >= 0),
  CONSTRAINT `CK_ACTMSTR_DEL_IND` CHECK (`DEL_IND` IN ('Y','N'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='활동 기록(대상자 활동/독립 활동 통합, 활동 건수·시간 집계 원천)';

CREATE TABLE `ORGACT` (
  `ORG_ACT_ID` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '조직원 활동 고유키',
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `EMPL_ID` varchar(60) NOT NULL COMMENT '조직원ID(현재 명부에 없어도 원본값 보존)',
  `EMPL_CODE` varchar(60) DEFAULT NULL COMMENT '구성원ID',
  `EMPL_NAME` varchar(100) DEFAULT NULL COMMENT '이름',
  `ACT_MONTH` char(7) NOT NULL COMMENT '활동월(YYYY-MM)',
  `ACT_DATE` date DEFAULT NULL COMMENT '활동일(월 단위는 NULL)',
  `PERIOD_KEY` varchar(10) NOT NULL COMMENT '기간키(일자 YYYY-MM-DD, 아니면 YYYY-MM)',
  `ACT_STATUS_CODE` tinyint NOT NULL COMMENT '활동 상태 1~4',
  `ORG_MSTR_CODE` varchar(60) DEFAULT NULL COMMENT '지역코드',
  `ORG_CODE` varchar(60) DEFAULT NULL COMMENT '구역코드',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_ORGACT` PRIMARY KEY (`ORG_ACT_ID`),
  CONSTRAINT `UK_ORGACT_PERIOD` UNIQUE (`LIB_ID`, `EMPL_ID`, `PERIOD_KEY`),
  KEY `IX_ORGACT_MONTH` (`LIB_ID`, `ACT_MONTH`),
  KEY `IX_ORGACT_ORG` (`ORG_MSTR_CODE`, `ORG_CODE`),
  CONSTRAINT `CK_ORGACT_STATUS` CHECK (`ACT_STATUS_CODE` BETWEEN 1 AND 4)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='조직원 활동 상태(지역활동)';

-- ---------------------------------------------------------------------
-- 6. 콜링 / 소셜링
-- ---------------------------------------------------------------------
CREATE TABLE `CALLMSTR` (
  `CALL_ID` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '콜링 고유키',
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `LEGACY_ID` varchar(80) DEFAULT NULL COMMENT '기존 원본 ID',
  `TGT_ID` bigint unsigned DEFAULT NULL COMMENT '대상자 TGT_ID(미연결 콜링 허용)',
  `TGT_NAME_HAN` varchar(100) DEFAULT NULL COMMENT '대상자명(당시 표기)',
  `TGT_CODE` varchar(60) DEFAULT NULL COMMENT '대상자 식별번호(당시 표기)',
  `INTRO_NAME` varchar(100) DEFAULT NULL COMMENT '인도자명(당시 표기)',
  `ORG_MSTR_CODE` varchar(60) DEFAULT NULL COMMENT '지역코드',
  `ORG_CODE` varchar(60) DEFAULT NULL COMMENT '구역코드',
  `BAN_CODE` varchar(60) DEFAULT NULL COMMENT '반',
  `FOUND_DATE` date DEFAULT NULL COMMENT '찾은 날짜',
  `CALL_DATE` date NOT NULL COMMENT '콜링일',
  `CALL_TIME` time DEFAULT NULL COMMENT '콜링시각',
  `CALLER_NAME` varchar(100) DEFAULT NULL COMMENT '콜러',
  `ROUND_NO` tinyint NOT NULL DEFAULT 0 COMMENT '차수(0~5)',
  `ROUND_NAME` varchar(60) DEFAULT NULL COMMENT '차수명',
  `RESULT_CODE` varchar(20) DEFAULT NULL COMMENT '결과',
  `ORIGINAL_RESULT` varchar(100) DEFAULT NULL COMMENT '원본 결과 표기',
  `REPORTED_RESULT` varchar(100) DEFAULT NULL COMMENT '보고 결과 표기',
  `NOTES` text DEFAULT NULL COMMENT '메모(API 5000자 제한)',
  `ATTEMPT_KEY_HASH` char(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL COMMENT '시도 해시(UNIQUE 아님)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_CALLMSTR` PRIMARY KEY (`CALL_ID`),
  KEY `IX_CALLMSTR_TGT` (`TGT_ID`, `CALL_DATE`),
  KEY `IX_CALLMSTR_LIB_DATE` (`LIB_ID`, `CALL_DATE`),
  KEY `IX_CALLMSTR_ORG` (`ORG_MSTR_CODE`, `ORG_CODE`),
  KEY `IX_CALLMSTR_HASH` (`ATTEMPT_KEY_HASH`),
  KEY `IX_CALLMSTR_LEGACY` (`LIB_ID`, `LEGACY_ID`),
  CONSTRAINT `CK_CALLMSTR_ROUND` CHECK (`ROUND_NO` BETWEEN 0 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='콜링 기록(해시 UNIQUE 없음, 레거시 중복 검토 전까지 일반 인덱스)';

CREATE TABLE `SOCMSTR` (
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `SOC_ID` varchar(60) NOT NULL COMMENT '소셜링 모임ID',
  `SOC_NAME` varchar(100) NOT NULL COMMENT '모임명',
  `ALIASES_JSON` longtext DEFAULT NULL COMMENT '별칭 JSON 배열',
  `USE_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '사용여부(Y/N)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_SOCMSTR` PRIMARY KEY (`LIB_ID`, `SOC_ID`),
  CONSTRAINT `CK_SOCMSTR_USE_IND` CHECK (`USE_IND` IN ('Y','N')),
  CONSTRAINT `CK_SOCMSTR_ALIASES` CHECK (`ALIASES_JSON` IS NULL OR JSON_VALID(`ALIASES_JSON`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='소셜링 모임 마스터';

CREATE TABLE `SOCDTL` (
  `SOC_DTL_ID` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '소셜링 유입 고유키',
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `LEGACY_ID` varchar(80) DEFAULT NULL COMMENT '기존 원본 ID',
  `SOC_ID` varchar(60) NOT NULL COMMENT '소셜링 모임ID',
  `TGT_ID` bigint unsigned DEFAULT NULL COMMENT '전환된 대상자 TGT_ID',
  `INFLOW_DATE` date DEFAULT NULL COMMENT '유입일',
  `INFLOW_NAME` varchar(100) DEFAULT NULL COMMENT '유입자명',
  `INTRO_NAME` varchar(100) DEFAULT NULL COMMENT '인도자명',
  `EMPL_ID` varchar(60) DEFAULT NULL COMMENT '인도자 조직원ID',
  `ORG_MSTR_CODE` varchar(60) DEFAULT NULL COMMENT '지역코드',
  `ORG_CODE` varchar(60) DEFAULT NULL COMMENT '구역코드',
  `NOTES` text DEFAULT NULL COMMENT '메모',
  `STATUS_CODE` varchar(20) NOT NULL DEFAULT 'pending' COMMENT '상태(pending/converted)',
  `CONVERTED_DTTM` datetime DEFAULT NULL COMMENT '전환일시',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_SOCDTL` PRIMARY KEY (`SOC_DTL_ID`),
  KEY `IX_SOCDTL_SOC` (`LIB_ID`, `SOC_ID`, `INFLOW_DATE`),
  KEY `IX_SOCDTL_TGT` (`TGT_ID`),
  KEY `IX_SOCDTL_ORG` (`ORG_MSTR_CODE`, `ORG_CODE`),
  KEY `IX_SOCDTL_LEGACY` (`LIB_ID`, `LEGACY_ID`),
  CONSTRAINT `CK_SOCDTL_STATUS` CHECK (`STATUS_CODE` IN ('pending','converted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='소셜링 유입(TGT_ID UNIQUE는 원본 확인 전까지 보류)';

-- ---------------------------------------------------------------------
-- 7. 찾기 일보 / 목표
-- ---------------------------------------------------------------------
CREATE TABLE `DAYMSTR` (
  `DAY_ID` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '일보 고유키',
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `LEGACY_ID` varchar(80) DEFAULT NULL COMMENT '기존 원본 ID',
  `REPORT_DATE` date NOT NULL COMMENT '보고일',
  `ORG_MSTR_CODE` varchar(60) NOT NULL COMMENT '지역코드',
  `ORG_CODE` varchar(60) NOT NULL COMMENT '구역코드',
  `FOUND_CNT` int NOT NULL DEFAULT 0 COMMENT '찾은 수',
  `ADVANCED_CNT` int NOT NULL DEFAULT 0 COMMENT '진급 수',
  `DROPPED_CNT` int NOT NULL DEFAULT 0 COMMENT '탈락 수',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_DAYMSTR` PRIMARY KEY (`DAY_ID`),
  CONSTRAINT `UK_DAYMSTR_DAY_ORG` UNIQUE (`LIB_ID`, `ORG_MSTR_CODE`, `ORG_CODE`, `REPORT_DATE`),
  CONSTRAINT `CK_DAYMSTR_CNT` CHECK (`FOUND_CNT` >= 0 AND `ADVANCED_CNT` >= 0 AND `DROPPED_CNT` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='찾기 일보 합계(구역·일자별)';

CREATE TABLE `DAYDTL` (
  `DAY_DTL_ID` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '일보 상세 고유키',
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `LEGACY_ID` varchar(80) DEFAULT NULL COMMENT '기존 원본 ID',
  `REPORT_DATE` date NOT NULL COMMENT '보고일',
  `TGT_ID` bigint unsigned DEFAULT NULL COMMENT '대상자 TGT_ID(미연결 허용)',
  `TGT_CODE` varchar(60) DEFAULT NULL COMMENT '대상자 식별번호',
  `TGT_NAME` varchar(100) DEFAULT NULL COMMENT '대상자명',
  `EMPL_ID` varchar(60) DEFAULT NULL COMMENT '인도자 조직원ID',
  `EMPL_CODE` varchar(60) DEFAULT NULL COMMENT '인도자 구성원ID',
  `EMPL_NAME` varchar(100) DEFAULT NULL COMMENT '인도자명',
  `FOUND_DATE` date DEFAULT NULL COMMENT '찾은 날짜',
  `FOUND_TIME` time DEFAULT NULL COMMENT '찾은 시간',
  `DATE_UNKNOWN_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '찾은날짜 미상(Y/N)',
  `STAGE_CODE` varchar(60) DEFAULT NULL COMMENT '단계',
  `REPORT_STATUS` varchar(10) NOT NULL COMMENT '보고구분(신규/유지/탈락)',
  `ORG_MSTR_CODE` varchar(60) DEFAULT NULL COMMENT '지역코드',
  `ORG_CODE` varchar(60) DEFAULT NULL COMMENT '구역코드',
  `BAN_CODE` varchar(60) DEFAULT NULL COMMENT '반',
  `ORG_PATH` varchar(300) DEFAULT NULL COMMENT '조직 경로',
  `SEX_CODE` varchar(20) DEFAULT NULL COMMENT '성별',
  `AGE` int DEFAULT NULL COMMENT '나이',
  `AGE_BASE_DATE` date DEFAULT NULL COMMENT '나이 기준일',
  `TOOL_NAME` varchar(200) DEFAULT NULL COMMENT '사용 도구',
  `RESIDENCE` varchar(200) DEFAULT NULL COMMENT '거주지',
  `PLACE_NAME` varchar(200) DEFAULT NULL COMMENT '찾은 장소',
  `CLASS1_CODE` varchar(20) DEFAULT NULL COMMENT '분류1',
  `CLASS2_CODE` varchar(20) DEFAULT NULL COMMENT '분류2',
  `TEACHER_NAME` varchar(100) DEFAULT NULL COMMENT '교사',
  `REASON` varchar(2000) DEFAULT NULL COMMENT '사유',
  `NOTES` text DEFAULT NULL COMMENT '메모',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_DAYDTL` PRIMARY KEY (`DAY_DTL_ID`),
  KEY `IX_DAYDTL_DATE` (`LIB_ID`, `REPORT_DATE`),
  KEY `IX_DAYDTL_TGT` (`TGT_ID`),
  KEY `IX_DAYDTL_ORG` (`ORG_MSTR_CODE`, `ORG_CODE`),
  KEY `IX_DAYDTL_LEGACY` (`LIB_ID`, `LEGACY_ID`),
  CONSTRAINT `CK_DAYDTL_DATE_UNKNOWN` CHECK (`DATE_UNKNOWN_IND` IN ('Y','N')),
  CONSTRAINT `CK_DAYDTL_STATUS` CHECK (`REPORT_STATUS` IN ('신규','유지','탈락')),
  CONSTRAINT `CK_DAYDTL_AGE` CHECK (`AGE` IS NULL OR (`AGE` >= 0 AND `AGE` <= 120))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='찾기 일보 상세(중복 업무행 임의 제거 금지, 이관 시 확인)';

CREATE TABLE `GOALMSTR` (
  `GOAL_ID` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '목표 고유키',
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `LEGACY_ID` varchar(80) DEFAULT NULL COMMENT '기존 원본 ID',
  `ORG_MSTR_CODE` varchar(60) DEFAULT NULL COMMENT '지역코드',
  `ORG_CODE` varchar(60) DEFAULT NULL COMMENT '구역코드',
  `BAN_CODE` varchar(60) DEFAULT NULL COMMENT '반',
  `FROM_DATE` date NOT NULL COMMENT '시작일',
  `TO_DATE` date NOT NULL COMMENT '종료일',
  `STAGE_CODE` varchar(60) DEFAULT NULL COMMENT '단계(NULL=전체)',
  `PERIOD_CODE` varchar(10) NOT NULL COMMENT '기간구분(week/month/custom)',
  `TARGET_CNT` int NOT NULL DEFAULT 0 COMMENT '목표 수(0 허용)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_GOALMSTR` PRIMARY KEY (`GOAL_ID`),
  KEY `IX_GOALMSTR_PERIOD` (`LIB_ID`, `FROM_DATE`, `TO_DATE`),
  KEY `IX_GOALMSTR_ORG` (`ORG_MSTR_CODE`, `ORG_CODE`, `BAN_CODE`),
  CONSTRAINT `CK_GOALMSTR_PERIOD` CHECK (`PERIOD_CODE` IN ('week','month','custom')),
  CONSTRAINT `CK_GOALMSTR_TARGET` CHECK (`TARGET_CNT` >= 0),
  CONSTRAINT `CK_GOALMSTR_RANGE` CHECK (`FROM_DATE` <= `TO_DATE`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='목표(중복 기간/범위 검증은 Service. NULL 유일성 트릭 사용 안 함)';

-- ---------------------------------------------------------------------
-- 8. 설정 / 변경이력
-- ---------------------------------------------------------------------
CREATE TABLE `SYSCFG` (
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `CONFIG_CODE` varchar(80) NOT NULL COMMENT '설정코드',
  `CONFIG_NAME` varchar(100) NOT NULL COMMENT '설정명',
  `CONFIG_VALUE` longtext DEFAULT NULL COMMENT '설정값(JSON 허용, 키/암호/비밀번호 저장 금지)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_SYSCFG` PRIMARY KEY (`LIB_ID`, `CONFIG_CODE`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='시스템 설정(주 시작 요일, 사용자 정의 항목 정의, 일보 열 배치, 활동자 순서, 제외 이름 통합, 사용자 메뉴 설정)';

CREATE TABLE `CHGLOG` (
  `CHG_ID` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '변경이력 고유키',
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `LEGACY_ID` varchar(80) DEFAULT NULL COMMENT '기존 원본 ID',
  `SEQ_NO` bigint unsigned NOT NULL COMMENT '해시 체인 순번',
  `ACTION_NAME` varchar(100) NOT NULL COMMENT '동작명',
  `TARGET_KIND` varchar(100) DEFAULT NULL COMMENT '대상 종류',
  `TARGET_ID` varchar(100) DEFAULT NULL COMMENT '대상 ID',
  `ACTOR_ID` varchar(60) DEFAULT NULL COMMENT '처리자ID',
  `ACTOR_NAME` varchar(100) DEFAULT NULL COMMENT '처리자명',
  `ACT_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '처리일시',
  `BEFORE_JSON` longtext DEFAULT NULL COMMENT '변경 전(민감정보 마스킹)',
  `AFTER_JSON` longtext DEFAULT NULL COMMENT '변경 후(민감정보 마스킹)',
  `PREV_HASH` char(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL COMMENT '이전 항목 해시',
  `ENTRY_HASH` char(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL COMMENT '항목 해시',
  `SOURCE_ENC` longtext DEFAULT NULL COMMENT '원본 감사자료 암호화 보존(연락처 평문 금지)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_CHGLOG` PRIMARY KEY (`CHG_ID`),
  KEY `IX_CHGLOG_LIB_SEQ` (`LIB_ID`, `SEQ_NO`),
  KEY `IX_CHGLOG_TARGET` (`TARGET_KIND`, `TARGET_ID`),
  KEY `IX_CHGLOG_ACT_DTTM` (`ACT_DTTM`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='변경 이력(해시 체인, 수정/삭제 없이 추가만)';

-- ---------------------------------------------------------------------
-- 9. 이관
-- ---------------------------------------------------------------------
CREATE TABLE `MIGJOB` (
  `JOB_ID` varchar(60) NOT NULL COMMENT '이관작업ID',
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `SOURCE_SHA256` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '원본 파일 SHA-256',
  `MAPPING_VERSION` varchar(30) NOT NULL COMMENT '매핑 규칙 버전',
  `STATUS_CODE` varchar(20) NOT NULL DEFAULT 'READY' COMMENT '상태(READY/RUNNING/DONE/FAILED)',
  `START_DTTM` datetime DEFAULT NULL COMMENT '시작일시',
  `END_DTTM` datetime DEFAULT NULL COMMENT '종료일시',
  `TOTAL_CNT` int NOT NULL DEFAULT 0 COMMENT '총 건수',
  `LOADED_CNT` int NOT NULL DEFAULT 0 COMMENT '적재 건수',
  `SKIPPED_CNT` int NOT NULL DEFAULT 0 COMMENT '건너뜀 건수',
  `ERROR_CNT` int NOT NULL DEFAULT 0 COMMENT '오류 건수',
  `MESSAGE` varchar(1000) DEFAULT NULL COMMENT '메시지(개인정보 금지)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_MIGJOB` PRIMARY KEY (`JOB_ID`),
  KEY `IX_MIGJOB_LIB` (`LIB_ID`, `SOURCE_SHA256`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='이관 작업 이력';

CREATE TABLE `MIGMAP` (
  `MAP_ID` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '이관 매핑 고유키',
  `JOB_ID` varchar(60) NOT NULL COMMENT '이관작업ID',
  `LIB_ID` varchar(60) NOT NULL COMMENT '자료실ID',
  `ENTITY_KIND` varchar(40) NOT NULL COMMENT '엔티티 종류(예: TGMSTR, ACTMSTR)',
  `SOURCE_ID` varchar(100) NOT NULL COMMENT '원본 ID',
  `TARGET_ID` varchar(100) NOT NULL COMMENT '적재된 대상 ID',
  `SOURCE_ROW_HASH` char(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL COMMENT '원본 행 해시',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_MIGMAP` PRIMARY KEY (`MAP_ID`),
  CONSTRAINT `UK_MIGMAP_SOURCE` UNIQUE (`LIB_ID`, `ENTITY_KIND`, `SOURCE_ID`),
  KEY `IX_MIGMAP_JOB` (`JOB_ID`),
  KEY `IX_MIGMAP_TARGET` (`ENTITY_KIND`, `TARGET_ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='이관 원본ID-대상ID 매핑(같은 원본 ID 재이관만 방지, 이름·전화번호로 병합 금지)';
