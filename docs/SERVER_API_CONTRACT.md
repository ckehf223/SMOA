# SMOA 서버 API·저장소 계약

2026-11-26. `backend/` 의 Spring Boot 서버가 제공하는 인증·권한 패키지·프로그램·계정 API, 업무 모듈 URL 계약, 그리고 사용자가 테이블을 설계한 뒤 MyBatis XML 에 연결해야 하는 Mapper 계약입니다. **테이블·업무 기능이 완성되었다는 뜻이 아닙니다.** 기능별 현황은 `docs/FUNCTION_PARITY.md`, 화면·모듈 추가 위치는 `docs/MODULE_INTEGRATION_GUIDE.md`.

## 1. 공통

- 동일 출처. CORS 허용 없음. 세션 쿠키 `SMOASESSION`(HttpOnly, SameSite=Lax, Secure, 유휴 30분).
- 변경 요청(POST/PUT/PATCH/DELETE)은 `X-CSRF-TOKEN` 헤더 필수. 헤더 이름·값은 `GET /api/auth/csrf` 응답을 사용한다. **로그인 전, 로그인 후, 로그아웃 후에 각각 다시 받는다**(이전 토큰은 폐기됨).
- 요청 본문은 허용 목록: 정의되지 않은 필드는 400(`fail-on-unknown-properties`). 동작 이름은 소문자(`read`,`write`,`export`)를 받는다.
- 오류 본문: `{"code","message","fields"?}`. 입력 원문·스택·SQL 은 없다.
- 상태: 미인증 401, 권한 없음/CSRF 실패/구역 밖 생성 403, 입력 오류 400, 범위 밖 단건·없는 자료 404, 중복·보호 항목·마지막 총관리자 409, 로그인 제한 429, **데이터 연결이 없는 업무 모듈 501 `MODULE_NOT_CONNECTED`**.

## 2. 인증 API

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/auth/csrf` | `{headerName, parameterName, token}` |
| `POST /api/auth/login` | **`application/x-www-form-urlencoded`**(`username`,`password`). 성공 200 + `me`, 실패 401 `LOGIN_FAILED`(존재·비활성·오답 동일), 제한 429 `LOGIN_LOCKED` |
| `POST /api/auth/logout` | 세션 폐기. CSRF 필요 |
| `GET /api/auth/me` | 현재 사용자. 미인증 401 |

웹 로그인 순서: `GET csrf` → `POST login` → `GET csrf`(새 토큰) → `GET me`. 인증 토큰은 HttpOnly 쿠키뿐이며 `localStorage` 에 저장하지 않는다.

`me` 응답 — **본인의 단일 패키지**와 허용된 프로그램만(다른 패키지의 권한 목록·비밀번호·해시·secret 없음):

```json
{
  "accountId": "uuid", "username": "login", "displayName": "표시명",
  "pkg": {"packageId": "uuid", "name": "1구역장"}, "packageActive": true,
  "admin": false, "noMenu": false,
  "menus": [{"programId":"people","name":"대상자 관리","group":"기록관리","page":"/pages/people.html","module":"records","actions":["export","read","write"]}],
  "permissions": {"people": {"access":true,"read":true,"write":true,"export":false}},
  "dataScope": {"type":"ORG","districts":[{"regionCode":"R1","districtCode":"D1"}]},
  "storageMode": "local-memory", "devMemory": true
}
```

`noMenu=true` 이면 화면은 안내만 보여 준다(첫 허용 프로그램으로 이동하며 대시보드로 강제하지 않는다).

## 3. 총관리자 API (`/api/admin/**`, 보호된 총관리자 시스템 패키지만)

총관리자 식별은 패키지 **이름이 아니라** 보호된 `superAdmin` 속성이다. 이 속성은 부트스트랩만 만들 수 있고 API 요청으로 바꿀 수 없다(요청에 `superAdmin` 이 있으면 400).

### 3.1 프로그램

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/admin/programs` | 목록(비활성 포함). `moduleConnected` = 모듈에서 실제 연결된 프로그램인가 |
| `POST /api/admin/programs` | 등록 `{programId,name,group?,category?,pagePath,moduleId,actions?,superAdminOnly?,active?,sortOrder?}` → 201 |
| `PATCH /api/admin/programs/{programId}` | `name,group,category,pagePath,moduleId,actions,active,sortOrder`. `programId` 변경 시도 400 |
| `GET /api/admin/modules` | 등록된 모듈 목록(프로그램 등록 시 `moduleId` 선택지) |
| `GET /api/admin/reference` | 지역·구역 기준 정보(패키지 구역 선택용) |

- `programId`: `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` (UUID·대문자·하이픈 허용, **불변**). 기존 24개 ID(`dashboard` … `permissions`) 유지, 관리 프로그램 `programs` 추가.
- `pagePath`: `/pages/<이름>.html`. 중복 409. `moduleId` 는 `ModulesConfig` 에 등록된 모듈만(아니면 400 `UNKNOWN_MODULE`). `actions` 는 `read/write/export`(access 는 항상 있으므로 400).
- 총관리자 전용 프로그램(`users`,`permissions`,`programs`)은 비활성화·전용 해제 불가(409 `PROTECTED_PROGRAM`).
- 비활성 프로그램은 모든 패키지에서 숨겨지고 페이지·API 직접 요청도 403. 동작을 줄이면 패키지에 남은 권한은 유효값으로 정규화된다.

### 3.2 권한 패키지

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/admin/packages`, `GET .../{id}` | 목록/단건. `accountCount` 포함 |
| `POST /api/admin/packages` | `{name, active?, permissions?, dataScope?}` → 201 |
| `PATCH /api/admin/packages/{id}` | 주어진 `permissions`/`dataScope` 는 **통째로 교체** |
| `DELETE /api/admin/packages/{id}` | 계정이 연결되어 있으면 409 `PACKAGE_IN_USE`. 시스템 패키지 409 `SYSTEM_PACKAGE_PROTECTED` |

- `name`: 자유 문자열 1~50자(1구역장/콜링팀장 등 — enum 아님). 이름 중복(대소문자·공백 무시) 409. 이름이 같아도 권한은 생기지 않는다.
- `permissions`: `{ "<programId>": {"access","read","write","export"} }`. 규칙 위반은 400: 미등록 프로그램, 프로그램에 없는 동작, `access=false` 인데 다른 동작, `read=false` 인데 write/export, 총관리자 전용 프로그램.
- `dataScope`: `{"type":"ALL"}` 또는 `{"type":"ORG","districts":[{"regionCode","districtCode"}]}`. **구역은 지역+구역 복합키**(R1/D1 ≠ R2/D1). 존재하지 않거나 비활성인 지역·구역 400 `UNKNOWN_DISTRICT`. ALL 에 districts 400. ORG 에 배정이 0개면 허용되지만 아무 자료도 보이지 않는다.
- 패키지 수정·비활성·구역 변경은 연결된 모든 로그인 계정의 **다음 요청부터** 반영된다(요청마다 account→활성 패키지→활성 프로그램→동작→범위를 다시 계산).

### 3.3 계정

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/admin/accounts`, `GET .../{id}` | 목록/단건(`packageId`,`packageName` 포함, 비밀 값 없음) |
| `POST /api/admin/accounts` | `{username, displayName, password, packageId, active?}` → 201 |
| `PATCH /api/admin/accounts/{id}` | `displayName`, `active`, `packageId` 만 |
| `PUT /api/admin/accounts/{id}/password` | `{"newPassword"}` → 204. 기존 세션 모두 무효 |

- **계정은 필수 `packageId` 정확히 하나.** `role`/`permissions`/`dataScope`/`scope` 같은 직접 입력은 400. 미존재 패키지 400 `PACKAGE_NOT_FOUND`, 비활성 패키지 400 `PACKAGE_INACTIVE`. 여러 계정이 같은 패키지를 쓸 수 있다.
- 로그인 ID `[A-Za-z0-9._-]{3,32}`(대소문자 무시 중복 409). 비밀번호 12~64자, 3종류 이상, ID 포함 금지.
- 마지막 활성 총관리자 비활성화·다른 패키지로 이동 → 409 `LAST_SUPER_ADMIN`.

## 4. 프로그램 페이지·업무 API 의 URL 계약 (필터가 강제)

| 대상 | 규칙 |
|---|---|
| 정적 자원 | `smoa.security.public-paths`(`/`,`/index.html`,`/login.html`,`/assets/**`)만 GET 공개. 사용자 자료는 포함하지 않는다 |
| 페이지 `/pages/<파일>.html` | 활성 프로그램의 `pagePath` 와 정확히 일치 + 활성 패키지의 access·read. 그 외 403(미인증 401) |
| `GET/HEAD /api/programs/{programId}/**` | access + read |
| `POST/PUT/PATCH/DELETE /api/programs/{programId}/**` | access + read + write |
| `/api/programs/{programId}/export/**` (GET/HEAD/POST) | access + read + export |
| `/api/admin/**` | 총관리자 시스템 패키지 |
| 그 밖 URL | 거부(미인증 401 / 인증 403) |

공통 모듈 엔드포인트(허용된 프로그램만):

| 경로 | 설명 |
|---|---|
| `GET /api/programs/{programId}/module` | `{programId,moduleId,title,connected,state(CONNECTED|NOT_CONNECTED),message}`. 구현 세부 없음 |
| `/api/programs/{programId}/data/**` | 데이터 연결이 없으면 **501 `MODULE_NOT_CONNECTED`**. 연결된 프로그램의 없는 경로는 404 |

### records 모듈(실제 동작: local-memory)

| 경로 | 프로그램·동작 |
|---|---|
| `GET /api/programs/people/options` | 단계 목록, 상태, **내 범위의 구역 선택지** |
| `GET/POST /api/programs/people/items`, `GET/PUT/DELETE .../items/{id}` | 대상자 조회(필터: regionCode,districtCode,stageId,status,q,includeDeleted)·등록·수정·소프트 삭제 |
| `POST .../items/{id}/stage` `{stageId,effectiveDate?,reason?}` | 단계 이동(이력 기록) |
| `POST .../items/{id}/dropout`, `.../return` `{effectiveDate,reason?}` | 탈락·복귀(이력 기록) |
| `POST .../items/{id}/undelete` | 삭제 취소(이력 기록) |
| `GET /api/programs/people/export/items.xlsx` | 대상자 엑셀(범위 내, 연락처 열 없음, 수식 문자 무력화) — export 권한 |
| `GET/POST /api/programs/activities/items`, `GET/PUT/DELETE .../items/{id}` | 활동 기록(대상자의 구역 범위를 따름) |
| `GET /api/programs/history/items?personId=` | 변경 이력(범위 내) |
| `GET /api/programs/stages/summary?from=&to=` | 단계 이동 집계(범위 내) |

구역 범위는 서비스의 `ScopeEnforcer` 가 서버 계정(패키지) 기준으로 강제한다: 범위 밖 단건·수정·삭제·이동은 **404**(존재 여부 비공개), 범위 밖 구역 생성·이동은 **403**, 배정 0개는 목록 0건. 비활성·미등록 지역/구역의 자료는 범위가 ALL 이어도 보이지 않는다. 클라이언트가 보낸 지역·구역 파라미터는 범위를 넓히지 못하고 좁히기만 한다.

## 5. 저장소 계약 (사용자 테이블 연결 시)

local/prod 는 아래 Mapper 인터페이스의 **모든 메서드**에 대응하는 statement 와 필수 resultMap 이 XML 에 있어야 기동한다. 없으면 `MapperContractVerifier` 가 **누락 목록과 함께** 기동을 중단한다(DB 연결 없이 설정만 검사, 메모리 자동 전환 없음). 사용자 입력은 `#{}` 바인딩만. 테이블/정렬 이름을 문자열로 이어 붙이지 않는다. 후보 테이블명(PGMMSTR/AUTHMSTR/AUTHDTL/AUTHORG/USERMSTR)은 **미확정**이며 이 저장소는 DDL 을 포함하거나 실행하지 않는다. 참고 사용자 테이블: PSMSTR(조직원), ORGMSTR(지역, PK ORG_MSTR_CODE), ORGDTL(구역, PK(ORG_MSTR_CODE, ORG_CODE)) — 읽기만 한다.

| Mapper (namespace) | XML | 필수 resultMap | 주요 statement |
|---|---|---|---|
| `program.persistence.ProgramMapper` | `mapper/program/ProgramMapper.xml` | `programRow`(programId,name,groupName,category,pagePath,moduleId,actions,superAdminOnly,active,sortOrder) | selectProgramById, selectProgramByPagePath, selectAllPrograms, insertProgram, updateProgram |
| `permission.persistence.PackageMapper` | `mapper/permission/PackageMapper.xml` | `packageRow`(packageId,name,nameKey,active,superAdmin,scopeType), `packagePermissionRow`(packageId,programId,access/read/write/exportAllowed), `packageDistrictRow`(packageId,**regionCode,districtCode**) | selectPackageById/ByNameKey, selectAllPackages, selectPermissionsByPackageId, selectDistrictsByPackageId, insert/update/deletePackage, delete/insertPermission, delete/insertDistrict |
| `account.persistence.AccountMapper` | `mapper/account/AccountMapper.xml` | `accountRow`(id,username,usernameKey,displayName,**packageId**,passwordHash,active,credentialVersion) | selectAccountById/ByUsernameKey, selectAllAccounts, countAccountsByPackageId, countActiveSuperAdmins(잠금 조회 권장), insertAccount(usernameKey 중복→DuplicateKeyException), updateAccount(영향 행 1) |
| `reference.persistence.ReferenceMapper` | `mapper/reference/ReferenceMapper.xml` | `regionRow`(regionCode,name,active), `districtRow`(regionCode,districtCode,name,active) | selectRegions, selectDistricts (**SELECT 만**) |
| `module.mapper.*Mapper` (7개) | `mapper/module/*.xml` | 없음(generic Map) | `docs/MODULE_INTEGRATION_GUIDE.md` 모듈별 표 |

패키지·계정 저장은 한 트랜잭션(`UnitOfWork`/`AdminMutationLock`)에서 수행한다. 알 수 없는 `scopeType` 값은 데이터 손상으로 보고 실패(거부)한다.

### 구역 범위 자료(업무 테이블) 계약

업무 Repository 는 `ScopedRepository<T extends DistrictScoped, ID>` 를 구현하고 구역은 `DistrictKey(regionCode, districtCode)` 로 식별한다. SQL 은 `DataScope` 를 WHERE 에 반영해야 한다: `ALL` 이면 조건 없음, `ORG` 이면 **(지역코드, 구역코드) 쌍** IN 조건이며 **집합이 비면 항상 0건**. `ScopeEnforcer` 가 저장소 결과를 다시 걸러내므로 이중 방어다. 연락처 원문·암호문은 일반 API 응답·로그·변경 이력에 넣지 않는다(끝 네 자리만).

## 6. 로깅·실행 환경 변수

| 변수 | 용도 |
|---|---|
| `SMOA_BOOTSTRAP_USERNAME`, `SMOA_BOOTSTRAP_PASSWORD` | local-memory 최초 총관리자(둘 다). 소스·yml 에 기본값 없음 |
| `SMOA_DB_HOST`, `SMOA_DB_PORT`, `SMOA_DB_NAME`, `SMOA_DB_USER`, `SMOA_DB_PASSWORD` | local/prod DB 접속. 코드·설정·테스트·로그에 실제 값 금지 |

프로파일: `local-memory`(가상 자료, DB 없음) / `local`(log4jdbc) / `prod`(일반 드라이버). 상세는 `backend/README.md`.
