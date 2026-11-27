# 단일 권한 패키지 모델 — 검토용 설계

2026-11-26. 사용자 확인: 계정 하나당 권한 패키지는 정확히 하나. 필요한 권한은 패키지에 추가한다. 1구역장/2구역장/콜링팀장/콜링자는 관리자가 만드는 패키지 이름이며 Java enum으로 고정하지 않는다. 테이블명·물리 타입은 사용자 확정 전의 제안이다. DDL이나 DB 적용은 하지 않는다.

후속 사용자 요청으로 권한 테이블 DDL 파일을 준비 중이다. 사용자 기존 명명 규칙에 맞춘 물리명은 PGMMSTR / AUTHMSTR / AUTHDTL / AUTHORG / USERMSTR이며 `db/permission-package.sql`을 기준으로 검토한다. 사용자 제공 PSMSTR(조직원), ORGMSTR(지역), ORGDTL(지역+구역 복합키)은 참조만 하고 변경하지 않는다. 구역 범위는 지역코드+구역코드 두 컬럼으로 식별해야 한다. DB에 적용한 것은 아니다.

## 기본 관계

- 계정 N : 1 권한 패키지. 계정에 package_id NOT NULL FK를 두며 다대다 account_packages 테이블은 만들 필요가 없다.
- 패키지 N : M 프로그램. 최하위 업무 메뉴의 고유 program_id로 연결하고 각 연결 행에 access/read/write/export 플래그를 둔다. 메뉴 이름·표시순서 변경이 ID를 바꾸지 않게 한다.
- 패키지 N : M 구역. 패키지의 data_scope_type이 ALL이면 전체, DISTRICT이면 배정된 구역만. 구역 행이 없으면 전체로 취급하지 않는다.
- 현재 기본안은 패키지의 구역 범위를 그 패키지가 가진 모든 프로그램에 공통 적용한다. 프로그램마다 서로 다른 데이터 범위가 필요한 경우에는 별도 요구로 설계한다.

## 최소 테이블

| 제안 테이블 | 주요 컬럼 | 제약 |
|---|---|---|
| programs | program_id PK, program_code UNIQUE, program_name, page_path, active | 최하위 메뉴/업무 기능 고유 ID. program_code는 사람이 읽는 불변 키로 필요할 때 사용 |
| permission_packages | package_id PK, package_name, data_scope_type, active | data_scope_type=ALL 또는 DISTRICT. 같은 이름 허용 여부는 관리 정책으로 정함 |
| package_program_permissions | package_id FK, program_id FK, can_access, can_read, can_write, can_export | (package_id,program_id) 복합 PK. 없는 행은 권한 없음. read는 access 필요, write/export는 read 필요 |
| package_districts | package_id FK, district_id FK | (package_id,district_id) 복합 PK. district_id는 사용자가 설계하는 구역 테이블의 키 |
| accounts | account_id PK, login_id UNIQUE, password_hash, display_name, package_id NOT NULL FK, active | 계정에 permissions/scope/직책별 권한을 별도로 중복 저장하지 않음 |

ID는 사용자가 선택한 BIGINT 또는 UUID 중 하나로 통일하고 FK는 부모와 동일 타입으로 맞춘다. 사람이 입력하는 로그인 ID/프로그램 코드의 대소문자 비교와 정확한 내부 키 비교는 구분한다. 비밀번호는 PasswordEncoder 해시만 저장한다. 감사/생성·수정 시각/비밀번호 변경 버전은 구현 시 필요한 별도 공통 컬럼으로 검토한다.

## 예시

- 프로그램 P01=현황, P02=대상자 관리, P03=콜링 관리.
- 패키지 PK01=1구역장, data_scope_type=DISTRICT.
- package_districts에는 (PK01,D01) 한 행.
- package_program_permissions에는 (PK01,P02,access=true,read=true,write=true,export=false) 한 행. P01/P03 행은 없으므로 접근 불가.
- 계정 U01/U02에 package_id=PK01을 저장하면 두 계정이 같은 권한을 공유한다.
- PK01에 프로그램 권한을 추가/회수하거나 허용 구역을 바꾸면 U01/U02 모두 다음 요청부터 변경 사항을 적용한다.

## 서버 검증 원칙

- 인증된 account_id로 활성 계정→활성 패키지→활성 프로그램→필요 동작→허용 구역 순서로 검사한다. 클라이언트가 보낸 package_id/scope로 자신을 승인하지 않는다.
- 계정별 직접 권한/범위와 하드코딩된 직책 enum은 이 모델의 운영 권한 원본으로 쓰지 않는다. 기존 backend 구현의 role/직접 permissions/scope는 최신 모델에 맞춘 재구성이 필요하다.
- 총관리자용 시스템 패키지/권한은 별도 보호가 필요하다. 마지막 총관리자가 사라지는 변경을 막고, 임의 패키지를 이름이 '총관리자'라는 이유로 관리자 취급하지 않는다. 관리 권한 부여는 명시적 보호된 속성/기능 권한으로 판단한다.
- 구역별 권한은 목록·단건조회·수정·삭제·내보내기·집계에 일관되게 적용한다. 허용 구역 0개는 0건/거부다.
- 화면 메뉴 표시와 실제 페이지 URL/API 권한을 모두 검사한다. 페이지 파일은 사용자가 작성하며 프로그램 ID와 라우트 매핑 계약을 유지한다.

## 남은 결정

- 사용자가 테이블명·키 타입·업무 구역 테이블을 확정한다.
- 지역장에 계정/패키지 관리 기능까지 줄지, 총관리자 전용일지 기존 질문 답변 대기다. 현재 서버 가정은 총관리자 전용이다.
- 프로그램 카탈로그를 DB에서 관리하는 실제 Mapper 계약, 프로그램별 지원 동작, 시스템 패키지 보호 정책을 위 관계에 맞춰 구현한다.
