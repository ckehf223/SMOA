-- =====================================================================
-- 001-web-persistence.sql  (웹 영속 연결 1단계에 필요한 최소 추가 컬럼)
--
-- [적용 방법] 에이전트가 적용하지 않는다. Codex 가 백업 후 검토하고 적용한다.
--  * 대상: 이미 26개 테이블이 만들어진 smoa DB. 기존 행 삭제/FK/DROP/TRUNCATE 없음.
--  * 컬럼 추가만 한다. 모든 추가 컬럼은 NOT NULL DEFAULT 또는 NULL 허용이라 기존 행(이관 자료)은 그대로 유효하다.
--  * 재실행 안전: 컬럼이 이미 있으면 건너뛴다(MariaDB ADD COLUMN IF NOT EXISTS).
--  * 적용 전 필수 백업: TGMSTR, ACTMSTR, PGMMSTR (mysqldump --single-transaction 등 사용자가 정한 방식).
--
-- [왜 필요한가]
--  * TGMSTR.DEL_IND / ACTMSTR.DEL_IND : 소프트 삭제. 원본 상태코드(STATUS_CODE)에 DELETED 를 끼워 넣지 않는다.
--  * ACTMSTR.ROW_VERSION             : 활동 수정 충돌(409) 감지. TGMSTR 에는 이미 ROW_VERSION 이 있다.
--  * PGMMSTR.MODULE_ID / CATEGORY_CODE: 프로그램 관리 화면이 모듈·분류를 저장할 곳. NULL 이면 서버가 기본 카탈로그로 해석한다.
--
-- [그 밖에 이 단계가 요구하는 기존 테이블 정합(이 파일 범위 밖, Codex 가 별도 확인)]
--  * PSMSTR.EMPL_ID 는 varchar(60) 이어야 한다(스키마 주석 참조).
--  * AUTHDTL / AUTHORG 의 기존 FK 는 제거되어 있어야 한다(FK 금지).
-- =====================================================================

ALTER TABLE `TGMSTR`
  ADD COLUMN IF NOT EXISTS `DEL_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '삭제여부(Y/N, 소프트 삭제)' AFTER `ROW_VERSION`;

ALTER TABLE `ACTMSTR`
  ADD COLUMN IF NOT EXISTS `ROW_VERSION` bigint unsigned NOT NULL DEFAULT 1 COMMENT '낙관적 잠금 버전' AFTER `MEMO`,
  ADD COLUMN IF NOT EXISTS `DEL_IND` varchar(1) NOT NULL DEFAULT 'N' COMMENT '삭제여부(Y/N, 소프트 삭제)' AFTER `ROW_VERSION`;

ALTER TABLE `PGMMSTR`
  ADD COLUMN IF NOT EXISTS `MODULE_ID` varchar(60) DEFAULT NULL COMMENT '처리 모듈 키(NULL 이면 서버 기본 카탈로그)' AFTER `GROUP_NAME`,
  ADD COLUMN IF NOT EXISTS `CATEGORY_CODE` varchar(20) DEFAULT NULL COMMENT '분류 BUSINESS/ADMIN(NULL 이면 서버 기본 카탈로그)' AFTER `MODULE_ID`;

-- 단순 Y/N 범위 제한(기존 행은 모두 DEFAULT 'N' 이라 위반하지 않는다).
ALTER TABLE `TGMSTR`  ADD CONSTRAINT IF NOT EXISTS `CK_TGMSTR_DEL_IND`  CHECK (`DEL_IND` IN ('Y','N'));
ALTER TABLE `ACTMSTR` ADD CONSTRAINT IF NOT EXISTS `CK_ACTMSTR_DEL_IND` CHECK (`DEL_IND` IN ('Y','N'));
