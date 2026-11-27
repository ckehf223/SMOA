# SMOA 기능 동등성(parity) 표 — 데스크톱 4.0.41 기준

작성: 2026-11-26. 기준은 **데스크톱 4.0.41 전체**(`src/ui/app.js` 22개 메뉴, `src/preload.cjs` 허용 IPC action 전체, 메뉴 내 data-action). 기존 웹(Node) 138개 경로는 `docs/legacy-route-inventory.json` 이다. 이 문서는 **완료 주장이 아니라 행별 현황**이다.

상태 값: **구현** = Java 로 이식되어 local-memory 에서 실제 동작하고 테스트로 검증됨 / **부분** = 일부 규칙만 이식 / **미이식** = Java 업무 규칙 없음(화면은 “데이터 연결 준비 중”, API 501) / **적응** = 데스크톱 전용 기능을 웹 방식으로 바꿔야 하며 미구현 / **제외·충돌** = 지침 충돌 또는 별도 작업 범위.

## 현재 웹 이식 상태 — 2026-11-27

Spring Boot는 기존 SMOA 웹 디자인의 로고, 테마, 표시 밀도, 관리 메뉴를 사용한다. 모바일에서 왼쪽 메뉴를 열고 닫을 수 있다. Chrome에서 가상 대상자 등록·목록 재조회와 콜링시트 메뉴를 확인했다. 실제 3지역 자료실은 SSH 터널로 연결한 local 프로파일에서 조회했다.

원본 화면과의 추가 대조를 통해 대시보드 주·월과 실적·활동 보기, 대상자와 활동 상세 팝업, 콜링 조회·입력·현황 배치, 구역·개인·반·단계 분석 표, 소셜링 모임별·월별 표를 정리했다. 권한 패키지는 왼쪽 목록과 오른쪽 편집으로 나누고 프로그램 선택 팝업 및 전체·지정 구역 선택을 사용한다. 콜링시트 화면은 이후 원본 자료를 받을 별도 메뉴로 유지한다.

| 메뉴 | 현재 연결 | 데스크톱 4.0.41 대비 남은 작업 |
|---|---|---|
| 대시보드 | 현재 대상자·탈락·단계별 인원, 기간·구역별 찾기·활동, 일별 추이 | 주·월 비교, 자료원 전환, 목표 카드, 상세 탐색 |
| 대상자, 활동, 단계 이동 | 실제 DB 목록·상세·기존 편집 경로, 대상자 XLSX, 50행 페이지와 SQL 전체 건수 | 데스크톱의 상세 보기와 정렬·엑셀 옵션 대조 |
| 변경 이력 | 사용자 요청으로 메뉴 비활성화. 기록 저장과 기존 이력은 보존 | — |
| 구역별 데이터 | 기간·구역·분류, 직전 기간, 활동자율, 찾기 연결, 시간대 집계·XLSX | 8주 단계 추이, 점유·전환 상세와 일계 보완 |
| 개인별·반별 데이터, 단계 강약 | 구역·기간·반·분류별 찾기·단계 날짜·활동 집계 및 XLSX, 기간 내 단계 간 건수 비율 | 전일자 현황, 상세 찾기·시간대, 코호트와 집단별 심화 비교 |
| 찾기·주관자 통계, 통계 진단 | 노방 찾기와 주관 시간 연결, 시간대·연결 사유, 기간별 품질·장소·도달률과 XLSX | 회차별 장소 점수, 대상자 구성, 소셜링 심화 진단 |
| 콜링 관리·현황 | 조회·권한 범위 편집·결과 보고, 회차와 미연결 기록, 표준/MIG XLSX 및 일보 미리보기·등록 | 기존 자료 전체에 대한 자동 대조 확대, 가져오기 용량 제한(1MB/2,000행) |
| 콜링시트 | 독립 메뉴, 구역 권한, 회차 담당자, 조회·편집·휴지통·엑셀 | 필요 시 노션 보기 조건의 추가 대조. 기존 노션 데이터는 이관하지 않음 |
| 조직, 공통코드, 목표, 지역활동 | 명부 조회·편집, 코드 조회, 목표·지역활동 조회와 개별 편집 | 조직 계층 편집, 공통코드 편집, 일괄 등록, 활동자 정렬·이름 통합 |
| 소셜링 관리·현황 | 모임·접수 조회, 월별 집계, XLSX | 모임·접수 저장과 대상자 전환, 전환 심화 분석 |
| 엑셀 · 자료 가져오기, 일보 변환 · 분석 | 사용자 요청으로 두 메뉴 비활성화. 콜링 관리의 엑셀·일보 기능은 사용 가능 | — |
| 설정 | 자료실과 주 시작 요일, 권한 범위 안에서 변경 | 사용자 정의 필드, 일보 열과 활동자 규칙 등 나머지 설정 |
| 사용자·권한·프로그램 | 계정당 단일 패키지, 메뉴·동작·구역 범위 관리 | 서버에 맞춘 데이터 관리·백업 UI와 데스크톱 설정 대조 |

실DB 대조 건수는 대상자 644명, 활동 2,253건, 콜링 712건, 변경 이력 10,547건, 구성원 119명, 목표 272건, 지역활동 1,947건이다. 소셜링은 모임 2개·접수 0건, 콜링시트는 0건이다. 새 콜링시트는 DB 백업 후 테이블 2개와 메뉴 1개를 추가했으며 기존 업무행 수와 FK 0을 확인했다. 실제 자료에 대한 검증은 목록·집계·내보내기 위주이며 생성·수정 검증은 가상 자료 또는 단위 테스트 범위다.

## 1. 2026-11-26 초기 이식 현황

- 메뉴/프로그램 25개: 미이식 18, 부분 4, 구현 3
- 데스크톱 IPC action 102개: 적응 12, 제외·충돌 16, 미이식 67, 구현 4, 부분 3
- 기존 웹 API 138개: 미이식 117, 구현 16, 부분 5

## 1.1 1단계(2026-11-26) 당시 영속 연결 현황

이 단계에서는 웹에서 MariaDB까지 계정·권한, 지역·구역, 대상자·활동·이력과 연결했다. 아래 표는 실제 DB 접속 검증 전의 초기 상태를 기록한다. 최신 결과는 상단의 현재 웹 이식 상태를 참고한다.

| 영역 | 상태 | 비고 |
|---|---|---|
| 계정·패키지·프로그램·구역 조회(USERMSTR/AUTHMSTR/AUTHDTL/AUTHORG/PGMMSTR/ORGMSTR/ORGDTL) | 코드·SQL 구현, DB 실행 검증 전 | DB 행잠금(총관리자 패키지 FOR UPDATE)으로 마지막 총관리자 보호 |
| 대상자(TGMSTR) 조회·등록·부분 수정·단계 이동·탈락/복귀·소프트 삭제·연락처(암호화) | 코드·SQL 구현, DB 실행 검증 전 | 원본 필드 전체, ROW_VERSION 409, LIB_ID·구역 복합키 범위 |
| 활동(ACTMSTR) 대상자 활동 + 독립 활동(TGT_ID NULL) | 코드·SQL 구현, DB 실행 검증 전 | 소프트 삭제·ROW_VERSION 은 001-web-persistence.sql 적용 필요 |
| 단계/상태/변경 이력(TGSTGLOG/TGSTATLOG/CHGLOG) | 코드·SQL 구현, DB 실행 검증 전 | 현재 행 + 이력 + CHGLOG 한 트랜잭션, CHGLOG 해시 체인 |
| 공통코드 조회(CODEDTL STAGE 등) | 읽기만 | 공통코드 **관리**(codes.*)는 미이식 |
| 지역활동·분석·소셜링·콜링·엑셀/일보 가져오기·목표·조직/설정 | **미이식 그대로 501** | 다음 단계에서 연속 이식 |

**따라서 업무 기능 이식은 완료되지 않았다.** 완료된 것은 인증·권한 패키지·프로그램/계정 관리와 records 모듈의 대상자·활동·변경 이력·단계 이동 집계·대상자 엑셀 내보내기뿐이다. 나머지는 아래 “미이식” 행이며 후속 구현 대상이다(우선순위는 5절).

## 2. 초기 메뉴(프로그램)별 현황

| 프로그램 ID | 메뉴 | 모듈 | 상태 | 원본 근거 | Java 처리 | 웹 화면 | 검증 증거 |
|---|---|---|---|---|---|---|---|
| dashboard | 대시보드 | analytics | 미이식 | dashboard.query, dashboard-drill, grid-reset, 기간 필터 | 없음(ModuleController 501) | pages/dashboard.html + assets/modules/analytics.js | 모듈 상태/501: ModuleApiTest |
| findingStats | 찾기·주관자 통계 | analytics | 미이식 | finding.stats.export, finding-stats.cjs(834줄) | 없음(ModuleController 501) | pages/findingStats.html + assets/modules/analytics.js | 모듈 상태/501: ModuleApiTest |
| regionData | 구역별 데이터 | analytics | 미이식 | regional-analytics.cjs, 월·지역 조회 | 없음(ModuleController 501) | pages/regionData.html + assets/modules/analytics.js | 모듈 상태/501: ModuleApiTest |
| memberData | 개인별 데이터 | analytics | 미이식 | performance.cjs, member-performance-tab | 없음(ModuleController 501) | pages/memberData.html + assets/modules/analytics.js | 모듈 상태/501: ModuleApiTest |
| classData | 반별 데이터 | analytics | 미이식 | performance.cjs | 없음(ModuleController 501) | pages/classData.html + assets/modules/analytics.js | 모듈 상태/501: ModuleApiTest |
| diagnostics | 통계 진단 | analytics | 미이식 | diagnostics.query, diagnostics.cjs·diagnostic-*.cjs | 없음(ModuleController 501) | pages/diagnostics.html + assets/modules/analytics.js | 모듈 상태/501: ModuleApiTest |
| stagePerformance | 단계 강약 분석 | analytics | 미이식 | stage-performance.query/details/export, full-time-performance.* | 없음(ModuleController 501) | pages/stagePerformance.html + assets/modules/analytics.js | 모듈 상태/501: ModuleApiTest |
| socialingManage | 소셜링 관리 | socialing | 미이식 | socialing.query/program.save/intake.save/intake.delete/promote | 없음(ModuleController 501) | pages/socialingManage.html + assets/modules/socialing.js | 모듈 상태/501: ModuleApiTest |
| socialingStats | 소셜링 데이터현황 | analytics | 미이식 | socialing.cjs 집계 | 없음(ModuleController 501) | pages/socialingStats.html + assets/modules/analytics.js | 모듈 상태/501: ModuleApiTest |
| callingManage | 콜링 관리 | calling | 미이식 | calling.query/people/save/delete/excel.*/report.* | 없음(ModuleController 501) | pages/callingManage.html + assets/modules/calling.js | 모듈 상태/501: ModuleApiTest |
| callingStats | 콜링 데이터 현황 | analytics | 미이식 | calling-report.cjs 집계 | 없음(ModuleController 501) | pages/callingStats.html + assets/modules/analytics.js | 모듈 상태/501: ModuleApiTest |
| people | 대상자 관리 | records | 부분(DB 영속 코드 완료·DB 실행 전) | person.save/delete/restore/lifecycle + 엑셀 내보내기 | records.RecordsService / RecordsController → RecordsMapper.xml(TGMSTR) | pages/people.html + assets/modules/records.js | ScopeAndRecordsTest, RecordsFullFieldApiTest, MyBatisRecordRepositoryTest, MapperSqlContractTest, ContactCryptoTest |
| activities | 활동 기록 | records | 부분(DB 영속 코드 완료·DB 실행 전) | activity.save/delete/delete.batch | records.RecordsService / RecordsController → RecordsMapper.xml(ACTMSTR) | pages/activities.html + assets/modules/records.js | ScopeAndRecordsTest, RecordsFullFieldApiTest |
| regionalActivity | 지역활동기록 | records | 미이식 | regional.activity.choose/import/save/remove/copy-report | 없음(ModuleController 501) | pages/regionalActivity.html + assets/modules/records.js | 모듈 상태/501: ModuleApiTest |
| stages | 단계 이동 분석 | records | 부분 | stage-cohort.cjs, 단계 이동 이력 집계 | records.RecordsService.stageSummary(TGSTGLOG, 기준 행 제외). 코호트 분석(stage-cohort)은 미이식 | pages/stages.html + assets/modules/records.js | ScopeAndRecordsTest |
| history | 변경 이력 | records | 부분(DB 영속 코드 완료·DB 실행 전) | history-mode, history-detail, restore | records.RecordsService.history(TGSTGLOG/TGSTATLOG/CHGLOG 병합). 변경 전·후 상세(BEFORE/AFTER_JSON) 표시·이력에서 복원은 미이식 | pages/history.html + assets/modules/records.js | ScopeAndRecordsTest, MyBatisRecordRepositoryTest |
| reports | 엑셀 · 자료 가져오기 | imports | 미이식 | excel.export/template/choose/import, import-preview.cjs | 없음(ModuleController 501) | pages/reports.html + assets/modules/imports.js | 모듈 상태/501: ModuleApiTest |
| daily | 일보 변환 · 분석 | imports | 미이식 | daily.*, daily.area.* | 없음(ModuleController 501) | pages/daily.html + assets/modules/imports.js | 모듈 상태/501: ModuleApiTest |
| goals | 구역·반 기간 목표 | goals | 미이식 | goal.save/list/batch/delete/export | 없음(ModuleController 501) | pages/goals.html + assets/modules/goals.js | 모듈 상태/501: ModuleApiTest |
| settings | 설정 | organization | 미이식 | settings.save | 없음(ModuleController 501) | pages/settings.html + assets/modules/organization.js | 모듈 상태/501: ModuleApiTest |
| organization | 조직 · 구성원 관리 | organization | 미이식 | organization.* | 없음(ModuleController 501) | pages/organization.html + assets/modules/organization.js | 모듈 상태/501: ModuleApiTest |
| codes | 공통코드 관리 | organization | 미이식 | codes.* | 없음(ModuleController 501) | pages/codes.html + assets/modules/organization.js | 모듈 상태/501: ModuleApiTest |
| users | 사용자 관리(신규 웹 관리) | identity | 구현 | 데스크톱의 잠금·비밀번호 대신 서버 계정 | account.AccountAdminService / web.AdminController | pages/users.html + assets/modules/identity.js | AccountAdminApiTest, LastSuperAdminTest |
| permissions | 권한 패키지 관리(신규 웹 관리) | identity | 구현 | 기존 role 기반 permissions 를 단일 패키지로 대체 | permission.PackageService / web.AdminController | pages/permissions.html + assets/modules/identity.js | PackageAdminApiTest, PackageChangePropagationTest |
| programs | 프로그램 관리(신규 웹 관리) | identity | 구현 | 신규 | program.ProgramService / web.AdminController | pages/programs.html + assets/modules/identity.js | ProgramAdminApiTest |

## 3. 데스크톱 IPC action 전체 (`src/preload.cjs`)

| action | 메뉴 | 상태 | 웹/Java 대응 | 비고 |
|---|---|---|---|---|
| status | 공통 | 적응 | /api/auth/me | 자료실 상태 → 서버 세션 상태 |
| create | 공통 | 제외·충돌 | - | 자료실 생성(금고 비밀번호) — 웹은 서버 계정·DB 로 대체 |
| unlock | 공통 | 적응 | POST /api/auth/login | formLogin + CSRF, 시도 제한 |
| lock | 공통 | 적응 | POST /api/auth/logout, 세션 유휴 만료 30m | Electron 잠금 → 세션 |
| touch | 공통 | 적응 | 세션 유휴 타임아웃 |  |
| state | 공통 | 적응 | 업무 API 별 조회 | 전체 상태 덤프 대신 프로그램별 API |
| query | 대시보드 | 미이식 | analytics 모듈 data API | src/dashboard.cjs |
| password.change | 공통 | 미이식 | (없음) 계정 본인 비밀번호 변경 API 미구현 | 총관리자 초기화만 있음 |
| backup.list | 공통 | 제외·충돌 | - | 자료실 백업 → 서버 DB 백업(운영 절차)로 대체 필요. 최신 요구와 AGENTS 충돌 항목 |
| backup.restore | 공통 | 제외·충돌 | - | 위와 동일 |
| workspace.create | 공통 | 제외·충돌 | - | 자료실 생성·전환·관리: AGENTS 는 웹 이관에서 제외, 최신 요구는 대응 설계. 충돌 보고 참조 |
| workspace.switch | 공통 | 제외·충돌 | - | 위와 동일 |
| workspace.rename | 공통 | 제외·충돌 | - | 위와 동일 |
| workspace.delete.preview | 공통 | 제외·충돌 | - | 위와 동일 |
| workspace.delete | 공통 | 제외·충돌 | - | 위와 동일 |
| share.export | 공통 | 제외·충돌 | - | .cddshare 공유: AGENTS 는 제외(권한 경계로 대체), 최신 요구는 암호화 업·다운로드 설계. 충돌 보고 참조 |
| share.choose | 공통 | 제외·충돌 | - | 위와 동일 |
| share.preview | 공통 | 제외·충돌 | - | 위와 동일 |
| share.import | 공통 | 제외·충돌 | - | 위와 동일 |
| settings.save | 설정 | 미이식 | organization 모듈 | src/main.cjs settings.save |
| migration.choose | 공통 | 제외·충돌 | - | 기존 자료 이관은 웹 기능 검증 후 별도 작업(AGENTS) |
| migration.preview | 공통 | 제외·충돌 | - | 위와 동일 |
| migration.import | 공통 | 제외·충돌 | - | 위와 동일 |
| migration.cancel | 공통 | 제외·충돌 | - | 위와 동일 |
| diagnostics.query | 통계 진단 | 미이식 | analytics |  |
| stage-performance.query | 단계 강약 분석 | 미이식 | analytics |  |
| stage-performance.details | 단계 강약 분석 | 미이식 | analytics |  |
| stage-performance.export | 단계 강약 분석 | 미이식 | analytics | stage-performance-workbook.cjs |
| full-time-performance.query | 단계 강약 분석 | 미이식 | analytics |  |
| full-time-performance.export | 단계 강약 분석 | 미이식 | analytics |  |
| performance.export | 개인/반별 데이터 | 미이식 | analytics |  |
| finding.stats.export | 찾기·주관자 통계 | 미이식 | analytics |  |
| socialing.query | 소셜링 관리 | 미이식 | socialing |  |
| socialing.program.save | 소셜링 관리 | 미이식 | socialing |  |
| socialing.intake.save | 소셜링 관리 | 미이식 | socialing |  |
| socialing.intake.delete | 소셜링 관리 | 미이식 | socialing |  |
| socialing.promote | 소셜링 관리 | 미이식 | socialing | 소셜링→대상자 전환 |
| calling.query | 콜링 관리 | 미이식 | calling | 회차·미연결·원문 결과 |
| calling.people | 콜링 관리 | 미이식 | calling |  |
| calling.save | 콜링 관리 | 미이식 | calling |  |
| calling.delete | 콜링 관리 | 미이식 | calling |  |
| calling.excel.template | 콜링 관리 | 미이식 | calling |  |
| calling.excel.export | 콜링 관리 | 미이식 | calling |  |
| calling.excel.preview | 콜링 관리 | 미이식 | calling | 미리보기 중복/오류 |
| calling.excel.apply | 콜링 관리 | 미이식 | calling | 미리보기 확정 |
| calling.report.preview | 콜링 관리 | 미이식 | calling |  |
| calling.report.export | 콜링 관리 | 미이식 | calling |  |
| calling.report.copy | 콜링 관리 | 적응 | calling(브라우저 클립보드) | 미이식 |
| codes.group.save | 공통코드 | 미이식 | organization |  |
| codes.item.save | 공통코드 | 미이식 | organization |  |
| codes.group.delete | 공통코드 | 미이식 | organization |  |
| codes.item.delete | 공통코드 | 미이식 | organization |  |
| codes.collect | 공통코드 | 미이식 | organization |  |
| codes.export | 공통코드 | 미이식 | organization |  |
| organization.node.save | 조직 | 미이식 | organization |  |
| organization.member.save | 조직 | 미이식 | organization |  |
| organization.node.delete | 조직 | 미이식 | organization |  |
| organization.member.delete | 조직 | 미이식 | organization |  |
| organization.class.batch | 조직 | 미이식 | organization |  |
| organization.export | 조직 | 미이식 | organization |  |
| organization.template | 조직 | 미이식 | organization |  |
| excel.simple.template | 조직/엑셀 | 미이식 | imports |  |
| person.save | 대상자 | 구현(영속 코드) | POST/PUT·PATCH /api/programs/people/items[/{id}], PUT .../{id}/phone | 원본 필드 전체 + 부분 수정(보낸 필드만, null=지움) + ROW_VERSION 409 + 연락처 AES-256-GCM. 검증: RecordsFullFieldApiTest. DB 실행 전 |
| person.delete | 대상자 | 구현 | DELETE /api/programs/people/items/{id} | 소프트 삭제 + 이력 |
| person.restore | 대상자/이력 | 구현 | POST .../items/{id}/undelete |  |
| person.lifecycle | 대상자 | 부분 | POST .../{id}/stage|dropout|return | 단계 이동·탈락·복귀 + TGSTGLOG/TGSTATLOG + CHGLOG 한 트랜잭션, 적용 시각(한국)·시각 미상 구현. 탈락일 정정·이력 수정은 미이식 |
| activity.save | 활동 | 부분(영속 코드) | POST/PUT·PATCH /api/programs/activities/items | 날짜·시작/종료·분·종류·활동자·반·장소·세션·메모, 대상자 활동/독립 활동. 원본 `a.id` 기반 고유 규칙·참여자 목록 등 세부 활동 유형은 미이식 |
| activity.delete | 활동 | 구현 | DELETE .../items/{id} |  |
| activity.delete.batch | 활동 | 미이식 | (없음) | 선택 일괄 삭제 |
| regional.activity.choose | 지역활동 | 적응 | 파일 업로드 필요 | 미이식 |
| regional.activity.import | 지역활동 | 미이식 | records |  |
| regional.activity.save | 지역활동 | 미이식 | records |  |
| regional.activity.remove | 지역활동 | 미이식 | records |  |
| regional.activity.copy-report | 지역활동 | 미이식 | records |  |
| goal.save | 목표 | 미이식 | goals |  |
| goal.list | 목표 | 미이식 | goals |  |
| goal.batch | 목표 | 미이식 | goals |  |
| goal.delete | 목표 | 미이식 | goals |  |
| goal.export | 목표 | 미이식 | goals |  |
| excel.export | 엑셀 | 부분 | GET /api/programs/people/export/items.xlsx | 대상자 목록 단일 시트만. 원본 통합 업무 엑셀은 미이식 |
| excel.template | 엑셀 | 미이식 | imports |  |
| excel.choose | 엑셀 | 적응 | 브라우저 파일 업로드(multipart) 필요 | 미이식. OS 경로를 서버로 받지 않음 |
| excel.import | 엑셀 | 미이식 | imports | 미리보기→확정, 재실행 중복 방지 |
| daily.example | 일보 | 미이식 | imports |  |
| daily.folder.choose | 일보 | 적응 | 업로드/다운로드로 대체 | OS 폴더 선택은 웹에 없음 |
| daily.folder.open | 일보 | 적응 | 다운로드로 대체 | open-folder 불가 |
| daily.preview | 일보 | 미이식 | imports | daily-parser.cjs |
| daily.export | 일보 | 미이식 | imports |  |
| daily.area.export | 일보 | 미이식 | imports | daily-area-workbook.cjs |
| daily.area.cumulative.choose | 일보 | 적응 | 업로드로 대체 |  |
| daily.area.import.choose | 일보 | 적응 | 업로드로 대체 |  |
| daily.area.import.preview | 일보 | 미이식 | imports |  |
| daily.area.import.details | 일보 | 미이식 | imports |  |
| daily.area.import.apply | 일보 | 미이식 | imports |  |
| daily.area.activity-order.get | 일보 | 미이식 | imports |  |
| daily.area.activity-order.save | 일보 | 미이식 | imports |  |
| daily.area.activity-roster.get | 일보 | 미이식 | imports |  |
| daily.area.activity-roster.save | 일보 | 미이식 | imports |  |
| daily.area.slash-layout.get | 일보 | 미이식 | imports |  |
| daily.area.slash-layout.save | 일보 | 미이식 | imports |  |
| daily.analytics | 일보 | 미이식 | imports |  |
| daily.report | 일보 | 미이식 | imports |  |

## 4. 메뉴 내 세부 UI 기능(`src/ui/app.js` data-action 등)

| 기능 | 원본 | 웹 상태 | 비고 |
|---|---|---|---|
| 메뉴 트리 편집(menu-add-view, 메뉴 순서·숨김) | menu-tree.js | 미이식 | 서버 프로그램 순서·활성으로 대체. 사용자별 메뉴 편집은 미이식 |
| 필터 열기/초기화(toggle-filters, filters-reset) | app.js | 부분 | 대상자 목록 검색·단계·상태·구역 필터만 |
| 기간(period, activity-period) | app.js | 미이식 |  |
| 정렬(sort, perf-sort) | app.js | 미이식 | 표 정렬 미구현 |
| 페이지 이동(page-go/prev/next) | app.js | 미이식 | 목록 페이징 미구현(전체 목록) |
| 열 설정(grid-reset, grid.js) | grid.js | 미이식 |  |
| 대상자 상세/수정/삭제(person-detail/edit/delete) | app.js | 부분 | 상세 팝업 대신 목록·폼. 이력은 변경 이력 메뉴 |
| 활동 선택·일괄 삭제(activity-select-results 등) | app.js | 미이식 |  |
| 단계일·마일스톤(person-milestones.js) | person-milestones.js | 미이식 |  |
| 대시보드 드릴다운(dashboard-drill) | dashboard.js | 미이식 |  |
| 지역활동 모드(regional-activity-mode) | regional-activity.js | 미이식 |  |
| 조직 선택기(org-select, org-picker.js) | org-picker.js | 미이식 | 구역 선택은 패키지/대상자 폼의 지역+구역 선택으로 대체 |
| 공통코드 선택(code-select) | codes.js | 미이식 |  |
| 일보 템플릿/미리보기/내보내기/폴더(daily-*) | daily*.js | 미이식 |  |
| 일보 구역 누적·가져오기 적용(daily-area-import-*) | daily-area-import.js | 미이식 |  |
| 엑셀 미리보기 적용(excel-preview.js) | excel-preview.js | 미이식 |  |
| 누적 엑셀(cumulative-xlsx.cjs) | src | 미이식 |  |
| 공유 확정(share-confirm) | app.js | 제외·충돌 | 충돌 보고 참조 |
| 테마 전환(theme-toggle) | theme.js | 미이식 | 기본 라이트 테마만 |
| 잠금/비밀번호 변경(lock, password) | app.js | 적응 | 세션 만료·로그아웃. 본인 비밀번호 변경 API 미구현 |

## 5. 후속 구현 우선순위(Codex 인계)

1. **WorkspaceRepository 인터페이스 + 메모리 구현 확장**(조직/명부, 공통코드, 목표, 콜링, 소셜링): 원본 `src/model.cjs`(1354줄)의 정규화·ID·이력 규칙을 Java 도메인으로 옮긴다. 파일 단위 이식 순서: model → codes → organization → person-updates/person-status → activities → goals → socialing → calling.
2. **집계 알고리즘**: dashboard.cjs, performance.cjs(1602줄), regional-analytics.cjs, finding-stats.cjs, stage-performance.cjs, diagnostics*.cjs, calling-report.cjs. 원본 가상 fixture(`tests/*.test.cjs`)로 Java 결과를 대조한다.
3. **엑셀/일보**: importer.cjs(1570줄), reports.cjs, import-preview.cjs, daily*.cjs, daily-area-*.cjs, cumulative-xlsx.cjs. Apache POI 사용. 업로드(multipart)·미리보기·중복/오류·확정·재실행 중복 방지·이력.
4. **계정 본인 비밀번호 변경**, 목록 페이징·정렬, 활동 일괄 삭제.
5. ~~MyBatis 어댑터(records)~~: 2026-11-26 1단계에서 코드 완료(`MyBatisRecordRepository`, `RecordsMapper.xml`). **실제 DB 실행 검증은 Codex 후속.** 다음 단계: organization(명부·조직·코드 관리) → 콜링/소셜링 → 목표 → 분석 → 엑셀/일보 순으로 같은 방식(Mapper XML + 어댑터, 가짜 SQL 금지)으로 이식.

## 6. 지침 충돌 보고(숨기지 않음)

- **자료실·공유·백업**: AGENTS.md 는 “기존 자료실의 생성·전환·관리와 `.cddshare` 공유 파일 기능은 웹 이관 범위에서 제외, 공유와 접근 관리는 중앙 DB와 사용자·구역별 권한으로 처리”라고 한다. 이번 작업 지시는 “대응이 필요한 자료실/백업/공유 기능은 사용자당 권한 경계와 암호화 업·다운로드 방식으로 설계”하라고 한다. 이번 작업에서는 어느 쪽도 구현하지 않았다. 권한 경계(패키지·지역+구역)는 구현되어 있고, 공유파일/백업의 암호화 업·다운로드는 사용자 결정 후 별도 설계가 필요하다.
- **기존 AGENTS 의 “초기 개발은 로컬 Node.js”와 최신 “서버 런타임은 Java”**: 최신 지시를 따랐다. 기존 Node 코드는 변경하지 않았고 이 앱은 Node 를 실행·감싸지 않는다.
- **이전 작업의 “업무 API 501” 지침과 이번 “기존 기능 실제 동작” 지침**: 이번 지침을 우선해 records 일부를 실제 구현했으나 대부분은 여전히 501 이다. 이는 완료가 아니다.

## 7. 기존 웹(Node) API 138개 대응

| # | 모듈 | 메서드 | 경로 | 프로그램 | 동작 | Java 상태 | Java 대응 |
|---|---|---|---|---|---|---|---|
| 1 | business | GET | /api/dashboard | dashboard | read | 미이식 | (없음) |
| 2 | business | GET | /api/dashboard/overview | dashboard | read | 미이식 | (없음) |
| 3 | business | GET | /api/people | people | read | 구현 | GET /api/programs/people/items |
| 4 | business | GET | /api/people/export | people | export | 부분 | GET /api/programs/people/export/items.xlsx |
| 5 | business | POST | /api/people | people | write | 구현 | POST /api/programs/people/items |
| 6 | business | PUT | /api/people/:id | people | write | 구현 | PUT /api/programs/people/items/{id} |
| 7 | business | GET | /api/history/recoverable | history | read | 부분 | GET /api/programs/people/items?includeDeleted=true |
| 8 | business | POST | /api/history/recoverable/:id/restore | history | read | 구현 | POST /api/programs/people/items/{id}/undelete |
| 9 | business | GET | /api/people/options | people | write | 구현 | GET /api/programs/people/options |
| 10 | business | GET | /api/people/:id/detail | people | read | 부분 | GET /api/programs/people/items/{id} + history/items?personId= |
| 11 | business | POST | /api/people/:id/lifecycle | people | write | 부분 | POST .../{id}/stage|dropout|return |
| 12 | business | DELETE | /api/people/:id | people | write | 구현 | DELETE /api/programs/people/items/{id} |
| 13 | organization | GET | /api/organization | organization | read | 미이식 | (없음) |
| 14 | organization | GET | /api/organization/export | organization | export | 미이식 | (없음) |
| 15 | organization | GET | /api/organization/members/:id/transfers | organization | read | 미이식 | (없음) |
| 16 | organization | POST | /api/organization/nodes | organization | write | 미이식 | (없음) |
| 17 | organization | PUT | /api/organization/nodes/:id | organization | write | 미이식 | (없음) |
| 18 | organization | DELETE | /api/organization/nodes/:id | organization | write | 미이식 | (없음) |
| 19 | organization | POST | /api/organization/members | organization | write | 미이식 | (없음) |
| 20 | organization | PUT | /api/organization/members/:id | organization | write | 미이식 | (없음) |
| 21 | organization | DELETE | /api/organization/members/:id | organization | write | 미이식 | (없음) |
| 22 | organization | POST | /api/organization/classes | organization | write | 미이식 | (없음) |
| 23 | organization | GET | /api/organization/template | organization | write | 미이식 | (없음) |
| 24 | organization | POST | /api/organization/import/preview | organization | write | 미이식 | (없음) |
| 25 | organization | POST | /api/organization/import/apply | organization | write | 미이식 | (없음) |
| 26 | organization | GET | /api/goals | goals | read | 미이식 | (없음) |
| 27 | organization | GET | /api/goals/export | goals | export | 미이식 | (없음) |
| 28 | organization | GET | /api/goals/matrix | goals | write | 미이식 | (없음) |
| 29 | organization | POST | /api/goals/batch | goals | write | 미이식 | (없음) |
| 30 | organization | POST | /api/goals/copy/preview | goals | write | 미이식 | (없음) |
| 31 | organization | POST | /api/goals/copy/apply | goals | write | 미이식 | (없음) |
| 32 | organization | POST | /api/goals | goals | write | 미이식 | (없음) |
| 33 | organization | PUT | /api/goals/:id | goals | write | 미이식 | (없음) |
| 34 | organization | DELETE | /api/goals/:id | goals | write | 미이식 | (없음) |
| 35 | calling | GET | /api/calling/records | callingManage | read | 미이식 | (없음) |
| 36 | calling | GET | /api/calling/people | callingManage | write | 미이식 | (없음) |
| 37 | calling | POST | /api/calling/records | callingManage | write | 미이식 | (없음) |
| 38 | calling | PUT | /api/calling/records/:id | callingManage | write | 미이식 | (없음) |
| 39 | calling | DELETE | /api/calling/records/:id | callingManage | write | 미이식 | (없음) |
| 40 | calling | GET | /api/calling/records/export | callingManage | export | 미이식 | (없음) |
| 41 | calling | GET | /api/calling/template | callingManage | write | 미이식 | (없음) |
| 42 | calling | POST | /api/calling/import/preview | callingManage | write | 미이식 | (없음) |
| 43 | calling | POST | /api/calling/report/preview | callingManage | read | 미이식 | (없음) |
| 44 | calling | POST | /api/calling/import/apply | callingManage | write | 미이식 | (없음) |
| 45 | calling | POST | /api/calling/report/export | callingManage | export | 미이식 | (없음) |
| 46 | calling | GET | /api/calling/stats | callingStats | read | 미이식 | (없음) |
| 47 | calling | GET | /api/calling/stats/export | callingStats | export | 미이식 | (없음) |
| 48 | socialing | GET | /api/socialing/roster | socialingManage | read | 미이식 | (없음) |
| 49 | socialing | GET | /api/socialing/roster/export | socialingManage | export | 미이식 | (없음) |
| 50 | socialing | GET | /api/socialing/stats | socialingStats | read | 미이식 | (없음) |
| 51 | socialing | GET | /api/socialing/stats/export | socialingStats | export | 미이식 | (없음) |
| 52 | socialing | POST | /api/socialing/programs | socialingManage | write | 미이식 | (없음) |
| 53 | socialing | PUT | /api/socialing/programs/:id | socialingManage | write | 미이식 | (없음) |
| 54 | socialing | POST | /api/socialing/intakes | socialingManage | write | 미이식 | (없음) |
| 55 | socialing | PUT | /api/socialing/intakes/:id | socialingManage | write | 미이식 | (없음) |
| 56 | socialing | DELETE | /api/socialing/intakes/:id | socialingManage | write | 미이식 | (없음) |
| 57 | socialing | GET | /api/socialing/intakes/:id/candidates | socialingManage | write | 미이식 | (없음) |
| 58 | socialing | POST | /api/socialing/intakes/:id/promote | socialingManage | write | 미이식 | (없음) |
| 59 | socialing | GET | /api/socialing/introducers | socialingManage | write | 미이식 | (없음) |
| 60 | daily | GET | /api/daily/info | daily | read | 미이식 | (없음) |
| 61 | daily | PUT | /api/daily/settings | daily | write | 미이식 | (없음) |
| 62 | daily | POST | /api/daily/convert | daily | read | 미이식 | (없음) |
| 63 | daily | GET | /api/daily/conversions/:id/workbook | daily | export | 미이식 | (없음) |
| 64 | daily | POST | /api/daily/import-preview | daily | write | 미이식 | (없음) |
| 65 | daily | POST | /api/daily/import-file | daily | write | 미이식 | (없음) |
| 66 | daily | GET | /api/daily/imports/:id/details | daily | read | 미이식 | (없음) |
| 67 | daily | POST | /api/daily/apply | daily | write | 미이식 | (없음) |
| 68 | daily | POST | /api/daily/text-preview | daily | read | 미이식 | (없음) |
| 69 | daily | POST | /api/daily/text-apply | daily | write | 미이식 | (없음) |
| 70 | daily | POST | /api/daily/changes-preview | daily | read | 미이식 | (없음) |
| 71 | daily | GET | /api/daily/changes/:id/workbook | daily | export | 미이식 | (없음) |
| 72 | daily | GET | /api/daily/analytics | daily | read | 미이식 | (없음) |
| 73 | daily | POST | /api/daily/notice | daily | read | 미이식 | (없음) |
| 74 | daily | GET | /api/daily/notices/:id/workbook | daily | export | 미이식 | (없음) |
| 75 | daily | POST | /api/daily/conversions/:id/cumulative | daily | export | 미이식 | (없음) |
| 76 | reports | GET | /api/reports/info | reports | read | 미이식 | (없음) |
| 77 | reports | GET | /api/reports/summary | reports | read | 미이식 | (없음) |
| 78 | reports | GET | /api/reports/export | reports | export | 미이식 | (없음) |
| 79 | reports | GET | /api/reports/templates/:id | reports | read | 미이식 | (없음) |
| 80 | reports | GET | /api/reports/daily-totals | reports | read | 미이식 | (없음) |
| 81 | reports | POST | /api/reports/import-preview | reports | write | 미이식 | (없음) |
| 82 | reports | POST | /api/reports/target-update-preview | reports | write | 미이식 | (없음) |
| 83 | reports | POST | /api/reports/apply | reports | write | 미이식 | (없음) |
| 84 | records | GET | /api/activities | activities | read | 구현 | GET /api/programs/activities/items |
| 85 | records | GET | /api/activities/options | activities | read | 미이식 | (없음) |
| 86 | records | GET | /api/activities/export | activities | export | 미이식 | (없음) |
| 87 | records | POST | /api/activities | activities | write | 구현 | POST /api/programs/activities/items |
| 88 | records | PUT | /api/activities/:id | activities | write | 구현 | PUT /api/programs/activities/items/{id} |
| 89 | records | POST | /api/activities/delete | activities | write | 미이식 | (없음) |
| 90 | records | GET | /api/regional-activity | regionalActivity | read | 미이식 | (없음) |
| 91 | records | GET | /api/regional-activity/export | regionalActivity | export | 미이식 | (없음) |
| 92 | records | POST | /api/regional-activity/save | regionalActivity | write | 미이식 | (없음) |
| 93 | records | POST | /api/regional-activity/remove | regionalActivity | write | 미이식 | (없음) |
| 94 | records | POST | /api/regional-activity/import-preview | regionalActivity | write | 미이식 | (없음) |
| 95 | records | POST | /api/regional-activity/import-apply | regionalActivity | write | 미이식 | (없음) |
| 96 | records | GET | /api/stage-movements | stages | read | 부분 | GET /api/programs/stages/summary |
| 97 | records | GET | /api/stage-movements/export | stages | export | 미이식 | (없음) |
| 98 | records | GET | /api/history | history | read | 구현 | GET /api/programs/history/items |
| 99 | records | GET | /api/history/export | history | export | 미이식 | (없음) |
| 100 | analytics | GET | /api/analytics/finding-stats | findingStats | read | 미이식 | (없음) |
| 101 | analytics | GET | /api/analytics/finding-stats/export | findingStats | export | 미이식 | (없음) |
| 102 | analytics | GET | /api/analytics/diagnostics | diagnostics | read | 미이식 | (없음) |
| 103 | analytics | GET | /api/analytics/diagnostics/export | diagnostics | export | 미이식 | (없음) |
| 104 | analytics | GET | /api/analytics/stage-performance | stagePerformance | read | 미이식 | (없음) |
| 105 | analytics | GET | /api/analytics/stage-performance/details | stagePerformance | read | 미이식 | (없음) |
| 106 | analytics | GET | /api/analytics/stage-performance/export | stagePerformance | export | 미이식 | (없음) |
| 107 | analytics | GET | /api/analytics/full-time | memberData | read | 미이식 | (없음) |
| 108 | analytics | GET | /api/analytics/full-time/export | memberData | export | 미이식 | (없음) |
| 109 | analytics | GET | /api/analytics/region-data | regionData | read | 미이식 | (없음) |
| 110 | analytics | GET | /api/analytics/region-data/export | regionData | export | 미이식 | (없음) |
| 111 | analytics | GET | /api/analytics/member-data | memberData | read | 미이식 | (없음) |
| 112 | analytics | GET | /api/analytics/member-data/export | memberData | export | 미이식 | (없음) |
| 113 | analytics | GET | /api/analytics/class-data | classData | read | 미이식 | (없음) |
| 114 | analytics | GET | /api/analytics/class-data/export | classData | export | 미이식 | (없음) |
| 115 | admin | GET | /api/admin/users | (관리) |  | 구현 | GET /api/admin/accounts |
| 116 | admin | POST | /api/admin/users | (관리) |  | 구현 | POST /api/admin/accounts |
| 117 | admin | PATCH | /api/admin/users/:id | (관리) |  | 구현 | PATCH /api/admin/accounts/{id} |
| 118 | admin | POST | /api/admin/users/:id/password | (관리) |  | 구현 | PUT /api/admin/accounts/{id}/password |
| 119 | admin | GET | /api/admin/permissions | (관리) |  | 구현 | GET /api/admin/packages (role 기반 → 패키지) |
| 120 | admin | PUT | /api/admin/permissions/:role | (관리) |  | 구현 | PATCH /api/admin/packages/{id} (role 기반 → 패키지) |
| 121 | admin | GET | /api/admin/codes | (관리) |  | 미이식 | (없음) |
| 122 | admin | POST | /api/admin/codes/stages | (관리) |  | 미이식 | (없음) |
| 123 | admin | PATCH | /api/admin/codes/stages/:id | (관리) |  | 미이식 | (없음) |
| 124 | admin | POST | /api/admin/codes/groups | (관리) |  | 미이식 | (없음) |
| 125 | admin | PATCH | /api/admin/codes/groups/:id | (관리) |  | 미이식 | (없음) |
| 126 | admin | DELETE | /api/admin/codes/groups/:id | (관리) |  | 미이식 | (없음) |
| 127 | admin | POST | /api/admin/codes/groups/:id/items | (관리) |  | 미이식 | (없음) |
| 128 | admin | PATCH | /api/admin/codes/groups/:id/items/:itemid | (관리) |  | 미이식 | (없음) |
| 129 | admin | DELETE | /api/admin/codes/groups/:id/items/:itemid | (관리) |  | 미이식 | (없음) |
| 130 | admin | GET | /api/admin/codes/export | (관리) |  | 미이식 | (없음) |
| 131 | admin | POST | /api/admin/codes/import/preview | (관리) |  | 미이식 | (없음) |
| 132 | admin | POST | /api/admin/codes/import/apply | (관리) |  | 미이식 | (없음) |
| 133 | admin | GET | /api/admin/fields | (관리) |  | 미이식 | (없음) |
| 134 | admin | POST | /api/admin/fields | (관리) |  | 미이식 | (없음) |
| 135 | admin | PATCH | /api/admin/fields/:id | (관리) |  | 미이식 | (없음) |
| 136 | admin | DELETE | /api/admin/fields/:id | (관리) |  | 미이식 | (없음) |
| 137 | admin | GET | /api/admin/settings | (관리) |  | 미이식 | (없음) |
| 138 | admin | PUT | /api/admin/settings | (관리) |  | 미이식 | (없음) |
