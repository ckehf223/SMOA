# SMOA backend (Spring Boot)

HTML/CSS/JavaScript 모바일 웹이 호출하는 Spring Boot 서버입니다. 구조는 `RestController → Service → MyBatis Mapper 인터페이스 → Mapper XML`입니다. Gradle의 실행 JAR에 상위 프로젝트의 `frontend/` 정적 화면이 함께 들어갑니다.

- Java 21, Spring Boot 3.5.16, MyBatis Spring Boot Starter 3.0.5, Gradle 8.14.8(wrapper), 기본 패키지 `com.smoa`
- Spring Security **세션 인증**(+CSRF). 로그: **Log4j2** + log4jdbc(local 전용)
- 기존 Node.js 서버(`../server`)는 기능 대조용으로 그대로 있습니다.

## 프로파일 (반드시 하나 지정)

| 프로파일 | 용도 | DB | 비고 |
|---|---|---|---|
| `local-memory` | **가상 자료** 로컬 실행 | 없음 | 종료하면 계정·자료가 **모두 사라짐**. 실제 자료·연락처·운영 비밀번호 입력 금지. `127.0.0.1` 바인딩, 쿠키 `Secure=false`(HTTP) |
| `local` | 로컬 + 연결된 MariaDB | MariaDB(log4jdbc) | SQL 타이밍 로그 |
| `prod` | 운영 | MariaDB(일반 드라이버) | log4jdbc 비활성 |

- 프로파일이 없거나 둘 이상이면 컨텍스트 생성 전에 실패합니다(`StorageProfileGuard`). 메모리 모드로 자동 전환하지 않습니다.
- `local`/`prod`는 기존 MariaDB 스키마와 환경 변수를 사용합니다. Mapper XML에 필요한 statement가 없으면 `MapperContractVerifier`가 누락 목록을 표시하고 기동을 중단합니다.
- 스키마 자동 생성/초기화는 꺼져 있습니다(`spring.sql.init.mode=never`).

## IntelliJ에서 실행

1. **File → Open**에서 `SMOA` 루트 폴더를 Gradle 프로젝트로 열고 동기화합니다. Project 창에서 `backend` 모듈과 `frontend` 폴더를 확인합니다.
2. **Settings → Build Tools → Gradle → Gradle JVM** 을 **JDK 21** 로 지정, 그리고 **Project Structure → Project SDK** 도 21. (wrapper가 Gradle 8.14.8 을 받습니다.)
3. **Run/Debug Configuration → Spring Boot(또는 `SmoaApplication`)** :
   - *Active profiles*: `local-memory`
   - *Environment variables*: `SMOA_BOOTSTRAP_USERNAME=<가상 총관리자 ID>;SMOA_BOOTSTRAP_PASSWORD=<12자 이상, 소문자·대문자·숫자·기호 중 3종류+>`
     (환경 변수로만 지정합니다. 소스·yml에 기본 비밀번호는 없습니다. 둘 다 비우면 계정이 없어 로그인할 수 없습니다. 이 값을 저장소에 커밋하지 마세요.)
4. 실행하면 콘솔에 `[local-memory] 가상 자료 전용 메모리 모드 …` 경고가 나옵니다. `http://127.0.0.1:8080`.
5. **로그 확인**: 콘솔은 색상(시간 cyan / INFO green / ERROR red …)으로 나오고, 같은 내용이 `backend/logs/smoa-backend.log` 에 쌓입니다(IntelliJ는 `System.console()` 이 null 이지만 `disableAnsi="false"` 라서 색상이 유지됩니다).
6. **local(DB) 실행** — 사용자 테이블과 Mapper XML 작성 뒤: *Active profiles* `local`, 환경 변수 `SMOA_DB_HOST`, `SMOA_DB_PORT`, `SMOA_DB_NAME`, `SMOA_DB_USER`, `SMOA_DB_PASSWORD`. 화면 조회 시 콘솔·로그 파일에 `jdbc.sqltiming`(실행 SQL + `{executed in N msec}`)이 출력됩니다.

| | local | prod |
|---|---|---|
| 드라이버 / URL | `net.sf.log4jdbc.sql.jdbcapi.DriverSpy` / `jdbc:log4jdbc:mariadb://…` | `org.mariadb.jdbc.Driver` / `jdbc:mariadb://…` |
| SQL 로그 | `jdbc.sqltiming` DEBUG, `jdbc.sqlonly/audit/resultset/resultsettable/connection` 은 문자열 `'OFF'`, `HikariDataSource` ERROR | `jdbc.sqltiming` `'OFF'` |
| 쿠키 Secure | true(브라우저 localhost 예외) | true |
| 접속 정보 | 환경 변수만 | 환경 변수만 |

MyBatis 자체 SQL 출력(`log-impl`)은 `NoLoggingImpl` 로 꺼서 SQL이 두 번 찍히지 않습니다.

## 로깅 (Log4j2 + log4jdbc)

- Gradle 모든 configuration 에서 `spring-boot-starter-logging`, `logback-classic`, `log4j-to-slf4j` 제외. `spring-boot-starter-log4j2` 와 `org.bgee.log4jdbc-log4j2:log4jdbc-log4j2-jdbc4.1:1.16` 추가. SLF4J provider 는 Log4j2 하나입니다(테스트로 확인).
- `src/main/resources/log4j2.xml`: 콘솔 레이아웃은 요청 문자열 그대로 **한 줄**로 정의, `PatternLayout disableAnsi="false"`. 파일 `logs/smoa-backend.log`, 일 단위 롤링 `logs/smoa-backend.%d{yyyy-MM-dd}.log`, `TimeBasedTriggeringPolicy interval=1 modulate=true`, `DefaultRolloverStrategy max=10 fileIndex=min`. `root`/`com.smoa` INFO, `com.smoa` additivity=false.
- 파일 레이아웃은 `%d{yyyy/MM/dd HH:mm:ss,SSS} [%-5p] [%c{1.}] [%t]- %m%n` 로 정했습니다(콘솔과 같은 구성에 `%c{1.}`, 파일이라 ANSI 제외). **사용자가 가진 `fileLayout` 원문을 받지 못했으니 다르면 `log4j2.xml` 의 `fileLayout` 한 줄만 바꾸세요.**
- **보관 개수 주의**: 파일 패턴에 `%i` 가 없으므로 `max=10` 은 날짜 파일 10개 보관을 보장하지 않습니다. 오래된 날짜 파일 삭제가 필요하면 `<Delete>` 정리 액션을 별도로 추가해야 합니다(미구현).
- `log4jdbc.log4j2.properties`: `Slf4jSpyLogDelegator`, `drivers=org.mariadb.jdbc.Driver`, `dump.sql.maxlinelength=0`, `auto.load.popular.drivers=false`.

## 계정·권한 모델

- **회원가입 없음.** 총관리자(`SUPER_ADMIN`)만 계정을 만들고 권한·구역 범위·활성 상태를 바꿉니다. 사용자가 답하지 않아 **지역장도 계정 생성 금지**로 가정했습니다(바꾸려면 `AccountAdminService.requireSuperAdmin` 과 `/api/admin/**` 규칙 수정).
- 역할은 **생성 때만 쓰는 프리셋**이고 이후 수정할 수 없습니다. 권한은 계정에 저장된 명시 값으로만 판정합니다(권한 없음 = 거부).

| 프리셋 | 화면 권한 | 데이터 범위 기본값 |
|---|---|---|
| `SUPER_ADMIN` | 24개 화면 전체(export 포함), 계정 관리 | ALL |
| `REGIONAL_LEADER` | 업무 20개 화면의 read/write(export 없음). 계정 관리·`users`/`permissions` 화면 불가. `codes`/`settings` 는 프리셋에 넣지 않음(별도 부여 가능) | ALL |
| `DISTRICT_LEADER` | `people` access/read/write | ASSIGNED_DISTRICTS(빈 집합) |
| `CALLING_TEAM` | `callingManage` access/read/write | ASSIGNED_DISTRICTS(빈 집합) |

- 프리셋은 `permissions` 를 **생략**했을 때만 적용됩니다. `{}` 로 명시하면 아무 권한이 없는 계정이 됩니다.
- 동작: `access/read/write/export`. `access=false` 면 전부 false, `read=false` 면 write/export false. 화면에 없는 동작을 부여하려 하면 400. 저장 자료가 모순이어도 판정 시 같은 규칙으로 정규화합니다.
- **화면 카탈로그**는 `application.yml` 의 `smoa.screens`(key / 한글 label / group / category / actions / page / super-admin-only) 입니다. 기존 `server/permissions.js` 의 업무 20개 + 관리 4개를 옮겼습니다. 화면을 붙일 때 여기에 한 항목을 추가하면 됩니다(페이지 파일은 만들지 않았습니다). `users`/`permissions` 는 총관리자 외 부여 불가.
- **데이터 범위**: `ALL` 또는 `ASSIGNED_DISTRICTS + districtIds`. 구역 집합이 비면 0건/404/거부이며 전체로 해석하지 않습니다. 범위는 항상 서버가 저장된 계정으로 결정합니다(요청의 계정 ID·범위·구역 값은 범위를 넓히지 못함). 구역 ID는 `[A-Za-z0-9_-]{1,64}` 불투명 문자열이며 **구역 테이블이 없어 존재 검증은 하지 않습니다.**
- **URL 가드**(Security 필터): 기본 거부.
  - 페이지 `/pages/<파일>.html`: 카탈로그에 등록된 page 와 정확히 같고 access+read 일 때만 통과. 허용돼도 파일이 없으면 **404 가 정상**, 권한 없음 403, 미등록 403, 미인증 401.
  - API `/api/screens/{screenKey}/**`: GET/HEAD=read, POST/PUT/PATCH/DELETE=write, `/api/screens/{screenKey}/export/**`(GET/HEAD/POST)=export. 알 수 없는 화면·방식은 403.
  - `/api/admin/**`: 총관리자.
  - 그 밖의 모든 경로: 거부. `public/` 를 공개하지 않습니다(로그인 전 정적 파일이 필요하면 `smoa.security.public-paths` 에 GET 패턴을 직접 등록, `/api/`·`/pages/` 불가).
- **구역 범위**는 Service 계층의 `ScopeEnforcer` + `ScopedRepository` 로 강제합니다(목록은 Repository 에 scope 전달, 단건/수정/삭제도 같은 scope + 사후 검증). 범위 밖 단건은 존재하지 않는 것과 같은 **404**, 범위 밖 구역으로의 생성/이동은 **403**.
- **즉시 반영**: 세션에는 계정 ID 와 `credentialVersion` 만 저장하고, 매 요청 `AccountStateFilter` 가 저장소에서 계정을 다시 읽습니다. 권한·범위 변경은 다음 요청부터 적용, 비활성화·비밀번호 초기화(`credentialVersion` 증가, 비활성화도 증가)는 세션 무효화 + 401. 마지막 활성 총관리자는 비활성화할 수 없습니다(409).

## 인증 요약

- `GET /api/auth/csrf`, `POST /api/auth/login`(**`application/x-www-form-urlencoded`**, `URLSearchParams` 로 `username`/`password`), `POST /api/auth/logout`, `GET /api/auth/me`. 상세는 `docs/SERVER_API_CONTRACT.md`.
- 표준 formLogin 필터 사용: 세션 고정 방어(`changeSessionId`), SecurityContext 저장, 로그인/로그아웃 시 CSRF 토큰 폐기를 프레임워크가 처리. 로그인 전·후·로그아웃 후에 `/api/auth/csrf` 를 다시 호출해 새 토큰을 받습니다.
- 쿠키 `SMOASESSION`: HttpOnly, SameSite=Lax, 유휴 30분, `Secure`(local-memory 만 false). CORS 허용 없음(동일 출처). 비밀번호 BCrypt(strength 12), 12~64자·3종류 이상·로그인 ID 포함 금지.
- 로그인 실패 응답은 존재/비활성/오답을 구분하지 않고, (IP+ID) 5회·IP 단독 30회 실패 시 15분 잠금(429). 추적 항목은 1만 건 상한(만료 우선 정리 후 오래된 순 제거). 단일 인스턴스 메모리 기반입니다.
- 오류는 `{code, message}` JSON. 스택·SQL·입력 원문은 응답에 없습니다.

## 빌드·테스트 (DB 없음)

```
cd backend
# PowerShell 예: $env:JAVA_HOME='C:/Users/ckehf/.codex/tools/smoa-java/jdk/jdk-21.0.13.1+2'; $env:Path="$env:JAVA_HOME/bin;$env:Path"
./gradlew test bootJar
./gradlew dependencies --configuration runtimeClasspath
```

`test` 는 환경 변수 `SMOA_DB_*` 를 예약 도메인(`db.invalid`)·더미 값으로 고정하고 `SMOA_BOOTSTRAP_*` 를 비워 개발자 셸 값이 새지 않게 합니다. 테스트는 `local-memory` + `test-fixture`(테스트 소스에만 있는 fixture) 프로파일과 Mockito 가상 JDBC 만 사용하며 H2 로 스키마를 만들지 않습니다.

실행 결과(2026-11-26, JDK 21.0.13, Gradle 8.14.8): `./gradlew test bootJar` **성공, 75개 테스트 전부 통과**. `dependencies` 에서 logback / log4j-to-slf4j / spring-boot-starter-logging **없음** 확인. `bootRun`, 브라우저 수동 확인, 실제 DB 연결은 **실행하지 않았습니다.**

### 테스트가 확인하는 것

| 파일 | 내용 |
|---|---|
| `AuthFlowTest` | 미인증 401, 로그인/로그아웃 CSRF 토큰 재발급, CSRF 없음 403, 세션 ID 변경, 로그인 실패 응답 동일(오답/없는 계정/비활성), 쿠키 설정 |
| `PermissionMatrixTest` | 구역장 people 허용·현황 차단, 콜링팀 callingManage read/write·export 거부, 지역장 업무 전체·계정관리 거부, 총관리자, 미등록 화면·페이지 거부, 권한 누락·모순 기본 거부, 페이지 404/403 |
| `AccountAdminApiTest` | 총관리자 계정 생성, 일반 계정 생성/조회/권한 변경 거부, 중복(대소문자), 입력 검증·허용 목록, 응답에 비밀 없음 |
| `SessionRevalidationTest` | 권한 회수/부여·구역 변경·비활성·재활성·비밀번호 초기화가 기존 세션에 반영 |
| `ScopeEnforcementTest`, `ScopeEnforcerUnitTest` | 다른 구역 ID 직접 조회/수정/삭제/생성/이동 차단, 빈 구역 범위, 요청 값으로 범위 확대 불가, 누수 저장소 방어 |
| `LastSuperAdminTest`, `LoginThrottleTest` | 마지막 총관리자 보호, 로그인 잠금·만료·메모리 상한 |
| `StartupContractTest` | 프로파일 없음/중복 실패, local/prod Mapper 계약 미완료 실패(메모리 대체 없음), local-memory 는 DataSource 없이 기동 |
| `LoggingConfigTest` | 단일 SLF4J provider·Logback 없음, log4j2.xml 정의, 콘솔 ANSI(console 없음 환경), 스택 트레이스, 로그 파일 생성·1회 기록 |
| `Log4jdbcSqlLoggingTest` | 가상 JDBC 를 실제 `ConnectionSpy`/`PreparedStatementSpy` 로 감싼 뒤 파라미터 바인딩·여러 줄 SQL·들여쓰기·`{executed in N msec}` 출력 |
| `ConfigFilesTest` | local/prod 드라이버·URL·`'OFF'` 문자열, 비밀·IP 리터럴 없음 |

## 사용자가 남은 일 (이번 범위 밖)

- 화면(HTML/CSS/JS) 구현과 `smoa.security.public-paths`(로그인 페이지 등) 등록. CSP 가 `default-src 'self'` 라서 인라인 스크립트/스타일은 막힙니다(`SecurityConfig` 에서 조정).
- 테이블 설계 후 `mapper/account/AccountMapper.xml` 의 statement 작성(계약: `docs/SERVER_API_CONTRACT.md`), 이후 `local` 에서 실제 연결 확인.
- **실제 화면 조회 → MariaDB SQL 로그 확인**은 테이블·DB 연결 후 사용자가 실행합니다. 이번 log4jdbc 검증은 가상 JDBC 이며 실제 MariaDB 출력과 구분됩니다.
- 구역 테이블 연동(구역 ID 존재 검증), 업무 CRUD, 본인 비밀번호 변경 API, 로그 날짜 파일 보관 정리, 다중 인스턴스에서의 로그인 제한·계정 변경 락(현재 단일 인스턴스 락 + DB 트랜잭션; `countActiveSuperAdmins` 잠금 조회 권장).
- 여백 신청 연락처 암호화·끝 네 자리 응답은 이번 범위에 없습니다(연락처 필드 자체가 없음).
