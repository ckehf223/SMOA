-- =====================================================================
-- SMOA 권한 패키지 DDL (검토용 — 에이전트가 DB에 적용하지 않음)
--
-- [전제]
--  1) 사용자 정의 참조 테이블 PSMSTR, ORGMSTR, ORGDTL이 이미 존재한다.
--     이 파일은 세 테이블을 생성/변경하지 않으며 DDL도 포함하지 않는다.
--     - PSMSTR  : PK EMPL_ID varchar(60)
--     - ORGMSTR : PK ORG_MSTR_CODE varchar(60)
--     - ORGDTL  : PK (ORG_MSTR_CODE varchar(60), ORG_CODE varchar(60))
--  2) 참조 테이블은 ENGINE=InnoDB, CHARSET=utf8mb4, COLLATE=utf8mb4_general_ci 이며,
--     FK 컬럼의 타입/문자셋/collation이 아래 정의와 일치해야 한다. (실제 스키마는 조회하지 않았음)
--  3) 테이블명 대소문자(lower_case_table_names): 이 CREATE DDL은 0과 1 모두에서 실행 가능하다.
--     1이면 테이블명이 소문자로 저장되고 조회 시 대소문자를 구분하지 않는다.
--     사용자가 마지막으로 확인한 값은 0이고, 사용자가 원하는 목표값은 1이다(서로 다른 사실).
--     이 DDL은 서버 설정을 바꾸지 않는다. 목표값 1은 사용자가 별도로 적용·확인한 뒤
--     최종 테이블을 생성해야 한다. 어느 값이든 참조 테이블(PSMSTR, ORGMSTR, ORGDTL)의
--     실제 저장 이름이 FK 참조명과 일치해야 한다.
--  4) 대상 스키마는 접속 시점에 이미 선택되어 있다. (USE/CREATE DATABASE 없음)
--
-- 생성 순서: PGMMSTR -> AUTHMSTR -> AUTHDTL -> AUTHORG -> USERMSTR
-- 모든 FK: ON UPDATE RESTRICT / ON DELETE RESTRICT
-- SYS_* 값은 서버(Service)가 실행자/IP/시각으로 채운다. 자동 ON UPDATE는 두지 않는다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PGMMSTR : 프로그램(최하위 메뉴) 마스터
-- ---------------------------------------------------------------------
CREATE TABLE `PGMMSTR` (
  `PGM_ID` varchar(60) NOT NULL COMMENT '고유프로그램ID',
  `PGM_NAME_HAN` varchar(100) NOT NULL COMMENT '프로그램명',
  `PGM_URL` varchar(300) DEFAULT NULL COMMENT '페이지경로(미정은 NULL)',
  `USE_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '사용여부(Y/N)',
  `SYS_RUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템등록ID',
  `SYS_RUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템등록IP',
  `SYS_RUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템등록일시',
  `SYS_MUSR_ID` varchar(50) NOT NULL DEFAULT 'ADMIN' COMMENT '시스템수정ID',
  `SYS_MUSR_IP` varchar(50) NOT NULL DEFAULT '0.0.0.1' COMMENT '시스템수정IP',
  `SYS_MUSR_DTTM` datetime NOT NULL DEFAULT current_timestamp() COMMENT '시스템수정일시',
  CONSTRAINT `PK_PGMMSTR` PRIMARY KEY (`PGM_ID`),
  CONSTRAINT `UK_PGMMSTR_PGM_URL` UNIQUE (`PGM_URL`),
  CONSTRAINT `CK_PGMMSTR_USE_IND` CHECK (`USE_IND` IN ('Y','N'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='프로그램 마스터(최하위 메뉴 고유ID, 이름/경로가 바뀌어도 ID 유지)';

-- ---------------------------------------------------------------------
-- 2. AUTHMSTR : 권한 패키지 마스터
-- ---------------------------------------------------------------------
CREATE TABLE `AUTHMSTR` (
  `AUTH_CODE` varchar(60) NOT NULL COMMENT '권한패키지ID',
  `AUTH_NAME_HAN` varchar(60) NOT NULL COMMENT '패키지명',
  `DATA_SCOPE_CODE` varchar(10) NOT NULL DEFAULT 'ORG' COMMENT '데이터범위(ALL=전체, ORG=AUTHORG 허용 구역)',
  `SUPER_ADMIN_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '총관리자 전용 보호속성(Y/N, 이름으로 판단하지 않음)',
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

-- ---------------------------------------------------------------------
-- 3. AUTHDTL : 패키지별 프로그램 권한
-- ---------------------------------------------------------------------
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
  CONSTRAINT `FK_AUTHDTL_AUTHMSTR` FOREIGN KEY (`AUTH_CODE`)
    REFERENCES `AUTHMSTR` (`AUTH_CODE`) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `FK_AUTHDTL_PGMMSTR` FOREIGN KEY (`PGM_ID`)
    REFERENCES `PGMMSTR` (`PGM_ID`) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `CK_AUTHDTL_ACCESS_IND` CHECK (`ACCESS_IND` IN ('Y','N')),
  CONSTRAINT `CK_AUTHDTL_READ_IND` CHECK (`READ_IND` IN ('Y','N')),
  CONSTRAINT `CK_AUTHDTL_WRITE_IND` CHECK (`WRITE_IND` IN ('Y','N')),
  CONSTRAINT `CK_AUTHDTL_EXPORT_IND` CHECK (`EXPORT_IND` IN ('Y','N')),
  CONSTRAINT `CK_AUTHDTL_READ_NEEDS_ACCESS` CHECK (`READ_IND` = 'N' OR `ACCESS_IND` = 'Y'),
  CONSTRAINT `CK_AUTHDTL_WRITE_NEEDS_READ` CHECK (`WRITE_IND` = 'N' OR `READ_IND` = 'Y'),
  CONSTRAINT `CK_AUTHDTL_EXPORT_NEEDS_READ` CHECK (`EXPORT_IND` = 'N' OR `READ_IND` = 'Y')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='패키지별 프로그램 권한(행이 없으면 거부)';

-- ---------------------------------------------------------------------
-- 4. AUTHORG : 패키지별 허용 구역 (프로그램 전체에 공통 적용)
-- ---------------------------------------------------------------------
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
  KEY `IX_AUTHORG_ORG` (`ORG_MSTR_CODE`, `ORG_CODE`),
  CONSTRAINT `FK_AUTHORG_AUTHMSTR` FOREIGN KEY (`AUTH_CODE`)
    REFERENCES `AUTHMSTR` (`AUTH_CODE`) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `FK_AUTHORG_ORGMSTR` FOREIGN KEY (`ORG_MSTR_CODE`)
    REFERENCES `ORGMSTR` (`ORG_MSTR_CODE`) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `FK_AUTHORG_ORGDTL` FOREIGN KEY (`ORG_MSTR_CODE`, `ORG_CODE`)
    REFERENCES `ORGDTL` (`ORG_MSTR_CODE`, `ORG_CODE`) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='패키지별 허용 구역(DATA_SCOPE_CODE=ORG일 때 사용)';

-- ---------------------------------------------------------------------
-- 5. USERMSTR : 로그인 계정 (1계정 1권한패키지)
-- ---------------------------------------------------------------------
CREATE TABLE `USERMSTR` (
  `USER_ID` varchar(50) NOT NULL COMMENT '내부계정ID',
  `LOGIN_ID` varchar(60) NOT NULL COMMENT '로그인ID',
  `USER_NAME_HAN` varchar(60) NOT NULL COMMENT '표시이름',
  `PASSWORD_HASH` varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '비밀번호해시(BCrypt/PasswordEncoder)',
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
  CONSTRAINT `FK_USERMSTR_AUTHMSTR` FOREIGN KEY (`AUTH_CODE`)
    REFERENCES `AUTHMSTR` (`AUTH_CODE`) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `FK_USERMSTR_PSMSTR` FOREIGN KEY (`EMPL_ID`)
    REFERENCES `PSMSTR` (`EMPL_ID`) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `CK_USERMSTR_USE_IND` CHECK (`USE_IND` IN ('Y','N')),
  CONSTRAINT `CK_USERMSTR_PWD_HASH` CHECK (`PASSWORD_HASH` <> ''),
  CONSTRAINT `CK_USERMSTR_PWD_VERSION` CHECK (`PWD_VERSION` >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='로그인 계정(여러 계정이 같은 패키지를 사용할 수 있음)';
