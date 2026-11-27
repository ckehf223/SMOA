# Spring Boot 전환 방향

2026-11-26 KST. 사용자와 논의한 기술 방향이며 구현 완료 문서가 아니다.

## 확정한 범위

- 화면: HTML / CSS / JavaScript.
- 사용 형태: 모바일 브라우저에서 사용하는 모바일 웹. 외부 API 연계는 현재 고려하지 않는다(사용자 확인). 이 조건에서 세션 인증을 우선 추천하며 최종 인증 구현은 아직 하지 않았다.
- API: Spring Boot, RestController → Service → MyBatis Mapper 인터페이스 → Mapper XML.
- 빌드·설정: 사용자 확정 Gradle, application*.yml. IntelliJ에서 backend 단일 모듈을 연다. 구현 기준 Java21 / Boot3.5.16 / MyBatisStarter3.0.5 / Gradle8.14.8.
- DB: 기존 MariaDB, 관리 도구 DBeaver. 테이블은 사용자가 직접 설계한다.
- 운영 서버: 데이터스케일 Ubuntu 24.04, RAM 2GB. Nginx와 MariaDB는 설치 완료. JDK/Java 앱 설치는 아직 하지 않았다.
- 기존 Node.js 서버와 CJS 업무 알고리즘은 전환·집계·엑셀 검증의 비교 기준이다. 삭제하지 않는다.
- 이전 에이전트 DDL은 미확정 참고 자료이며 실행하지 않는다. 에이전트의 MariaDB 접근은 프로젝트 지침대로 조회 전용이다.

## 계층 책임

| 계층 | 책임 |
|---|---|
| RestController | 요청 DTO 검증, 인증된 사용자 정보 전달, 응답 DTO·HTTP 상태 |
| Service | 업무 규칙, 구역·대상자 접근 검사, 복수 변경의 트랜잭션 경계 |
| Mapper 인터페이스 | Java 메서드와 SQL 매핑 |
| Mapper XML | SQL, resultMap, 바인딩된 검색·정렬·페이지 조건 |
| Spring Security 필터 | 인증·세션, URL 권한, CSRF, 인증 실패·권한 오류 응답 |

Service의 `@Transactional`로 관련 DB 변경을 묶는다. XML의 사용자 입력은 `#{}` 바인딩을 기본으로 하며 정렬 컬럼은 허용 목록으로 선택한다. DTO를 통해 비밀번호 해시·연락처 원문·암호문이 응답으로 노출되지 않게 한다. 인증 여부와 개별 구역 자료 접근 권한은 각각 검사한다.

## 로그인 제안 — 아직 사용자 결정 전

후속 사용자 요청은 계정별 페이지/데이터 권한과 총관리자 발급 계정을 전제로 서버 개발을 진행하는 것이다. 회원가입은 제공하지 않는다. 총관리자만 계정 관리하는 기본 가정과 사용자 테이블 미정 여부를 질문했으며 답변 전까지 이를 명시한다. 지역장은 업무 전체, 구역장은 대상자 관리, 콜링팀은 콜링 관리만 기본 허용한다. 역할은 초기 템플릿이며 계정별 access/read/write/export와 서버 구역범위를 적용한다. 세부 구현·완료조건은 SPRING_SERVER_TASK.md를 따른다.

사용자는 모바일 웹을 사용하고 외부 API 연계는 아직 고려하지 않는다고 확인했다. 이 조건에서는 Spring Security + 서버 세션을 우선 제안한다. Nginx에서 화면과 /api를 동일 출처로 제공하고 브라우저는 HttpOnly/Secure/SameSite 세션 쿠키로 인증한다. CSRF 토큰은 변경 요청 헤더로 전달하며 로그인·로그아웃 후 토큰 갱신을 처리한다. 인증 쿠키와 JavaScript가 읽는 CSRF 토큰은 목적이 다르다. 모바일이라는 이유만으로 JWT를 요구하지 않으며 세션 만료·재로그인 UX를 설계한다.

서버 세션은 로그아웃·계정 정지·비밀번호 변경 시 무효화 정책을 적용한다. 역할/구역 권한 변경이 기존 세션에 즉시 반영되도록 재조회 또는 세션 무효화 정책이 필요하다. 비밀번호는 Spring Security PasswordEncoder의 BCrypt/Argon2 등으로 해시하고 평문이나 복호화 가능한 로그인 비밀번호를 저장하지 않는다. API는 미인증 401/권한 없음 403 JSON 응답을 사용한다.

JWT가 필요한 모바일·외부 API·여러 서비스 연계가 생기면 토큰 발급자/수신자·키·만료·갱신·회전·폐기 방식을 별도로 설계한다. localStorage에 장기 인증 토큰을 보관하는 방식은 기본안으로 삼지 않는다. JWT 자체가 CSRF/XSS나 권한 즉시 회수를 해결하지 않는다.

## 미정과 다음 단계

- 인증 최종 선택(세션/JWT), JDK·Spring Boot·MyBatis 호환 버전, Maven/Gradle 선택.
- Gradle/YAML과 Java21/Boot3.5.16/MyBatisStarter3.0.5/Gradle8.14.8 기준이 후속 결정됐다. 세션 인증 기반을 구현하며 JWT는 도입하지 않는다. 실제 테이블명·컬럼·SQL은 사용자 계약 대기다.
- 사용자 테이블 설계와 로그인 사용자/역할/구역 연결의 API 계약 확인. 에이전트가 테이블을 대신 확정하지 않는다.
- 계정/권한·대상자 CRUD부터 이식하고 기존 집계·일보·엑셀 알고리즘을 기능별로 대조한다. 초기 시험은 가상 자료와 DB 테스트 대역으로 진행한다.
- JVM·DB 메모리, DB 연결 수, 엑셀 동시 실행을 제한하고 실제 부하로 2GB 운영 여부를 판단한다. 서버 빌드 대신 별도 빌드 환경에서 만든 JAR 배포를 검토한다.
- 사용자 요청 없이 Java 설치·서버 재설정·운영 배포·DB 적용을 실행하지 않는다.

## 참고

- [Spring Security 세션](https://docs.spring.io/spring-security/reference/7.0/servlet/authentication/session-management.html)
- [JavaScript 요청과 CSRF](https://docs.spring.io/spring-security/reference/servlet/exploits/csrf.html)
- [OWASP JWT 검토 사항](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_Cheat_Sheet)
- [MyBatis-Spring 트랜잭션](https://mybatis.org/spring/transactions.html)
