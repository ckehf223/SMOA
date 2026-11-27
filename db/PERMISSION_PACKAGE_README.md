# 권한 패키지 DDL 검토 안내

`db/permission-package.sql`은 **검토용 파일**이며 에이전트가 DB에 적용하지 않았다(사용자가 검토 후 직접 실행할 수 있다). 사용자 정의 `PSMSTR`, `ORGMSTR`, `ORGDTL`은 생성·변경하지 않는다(DDL 미포함). 사용자 테이블의 FK 실제 존재 여부와 현재 스키마는 **조회하지 않았다**.

## 5개 테이블과 관계

```
PGMMSTR (PGM_ID)            AUTHMSTR (AUTH_CODE)
     ▲                       ▲      ▲        ▲
     │ FK                    │ FK   │ FK     │ FK
     └──── AUTHDTL ──────────┘      │        │
           (AUTH_CODE, PGM_ID)      │        │
                              AUTHORG     USERMSTR ──FK──▶ PSMSTR (EMPL_ID, 선택)
                 (AUTH_CODE, ORG_MSTR_CODE, ORG_CODE)
                       ├─FK─▶ ORGMSTR (ORG_MSTR_CODE)
                       └─FK─▶ ORGDTL  (ORG_MSTR_CODE, ORG_CODE) 복합 FK
```

| 테이블 | PK | 설명 |
|---|---|---|
| PGMMSTR | PGM_ID | 최하위 메뉴 고유ID. 이름/경로가 바뀌어도 ID 유지. PGM_URL UNIQUE(미정은 NULL) |
| AUTHMSTR | AUTH_CODE | 권한 패키지. DATA_SCOPE_CODE(ALL/ORG), SUPER_ADMIN_IND |
| AUTHDTL | (AUTH_CODE, PGM_ID) | 프로그램별 ACCESS/READ/WRITE/EXPORT |
| AUTHORG | (AUTH_CODE, ORG_MSTR_CODE, ORG_CODE) | 패키지 허용 구역 |
| USERMSTR | USER_ID | 로그인 계정. LOGIN_ID UNIQUE |

모든 FK는 `ON UPDATE RESTRICT / ON DELETE RESTRICT`이다. 암묵적 삭제, 고아 행, 이력 손실이 없다. 삭제 대신 `USE_IND='N'`으로 비활성화한다.

## 권한 규칙

- **1계정 1권한패키지**: `USERMSTR.AUTH_CODE` 하나. 여러 계정이 같은 패키지를 쓸 수 있고, 패키지를 수정하면 소속 모든 계정에 반영된다. **계정별 추가 권한은 없다.**
- **프로그램 권한**: `AUTHDTL` 행이 없으면 거부. 읽기는 접근 필요, 편집·내보내기는 읽기 필요(CHECK로 강제).
- **데이터 범위**: 패키지의 허용 구역은 프로그램 전체에 공통 적용된다.
  - `ALL`: `AUTHORG`를 사용하지 않는다.
  - `ORG`: `AUTHORG`에 등록된 구역만 허용. **행이 없으면 0건**.
  - 허용 구역의 `ORGMSTR.USE_IND`, `ORGDTL.USE_IND`도 서버에서 확인해 비활성 구역은 차단한다. FK는 존재 여부만 보장하며 활성 여부는 검증하지 않는다.
- **비활성 차단**: 패키지, 프로그램, 계정 중 하나라도 `USE_IND <> 'Y'`이면 차단한다(서버에서 검사).
- **미등록은 기본 `N`**: `USE_IND` 기본값이 `N`이므로 신규 등록 후 관리자가 활성화해야 한다.
- **총관리자**: `SUPER_ADMIN_IND`는 이름이 아니라 이 속성으로 판단한다. API에서 이 속성의 변경과 총관리자 패키지 수정을 보호하고, **마지막 총관리자는 보존**(비활성·삭제·패키지 변경 거부)한다.

## 서버 구현 시 유의사항

- `PASSWORD_HASH`(BCrypt/PasswordEncoder)는 API 응답과 일반 SQL 로그로 내보내지 않는다. Mapper 조회 컬럼에서도 인증 경로 외에는 제외한다.
- `PWD_VERSION`은 비밀번호 변경·강제 로그아웃 시 증가시켜 기존 세션을 무효화하는 용도다.
- `SYS_RUSR_*`/`SYS_MUSR_*` 기본값(`ADMIN`, `0.0.0.1`)은 자리표시자다. 서버가 실제 실행자·IP·시각을 채워야 한다. 수정 시각은 `ON UPDATE`가 없으므로 UPDATE문에서 명시한다.
- `USERMSTR.EMPL_ID`는 UNIQUE를 요구하지 않았으므로 두지 않았다. 명부 하나에 여러 계정이 연결될 수 있다.

## 검토 사항

- 사용자 `PSMSTR.ORG_CODE`에는 현재 지역코드가 없다. 구역코드가 지역별로 중복될 수 있으면 명부와 구역 연결이 모호해질 수 있다. 기존 테이블 변경문은 작성하지 않았고 사용자 판단 사항이다.
- 각 FK 컬럼의 타입·문자셋·collation은 사용자 제공 정의(varchar(60), utf8mb4_general_ci)에 맞췄으나 실제 DB와 대조하지 않았다.
- `lower_case_table_names`: 이 CREATE DDL은 0과 1 모두에서 실행 가능하다. 1이면 테이블명이 소문자로 저장되고 조회 시 대소문자를 구분하지 않는다. **사용자가 마지막으로 확인한 값은 0**이고 **사용자가 원하는 목표값은 1**이므로 둘을 구분한다. DDL은 서버 설정을 바꾸지 않으므로, 목표값 1을 별도로 적용·확인한 뒤 최종 테이블을 생성해야 한다. 어느 값이든 참조 테이블(`PSMSTR`, `ORGMSTR`, `ORGDTL`)의 실제 저장 이름이 FK 참조명과 일치해야 한다.

## 적용 전 읽기 전용 확인문 (실행하지 않음)

```sql
SHOW CREATE TABLE PSMSTR;
SHOW CREATE TABLE ORGMSTR;
SHOW CREATE TABLE ORGDTL;
SELECT @@lower_case_table_names;
```

적용(DDL 실행)은 사용자가 직접 판단·수행한다. 목표값 `lower_case_table_names=1`은 사용자가 서버 설정으로 별도 적용·확인한 뒤 최종 테이블을 생성한다.
