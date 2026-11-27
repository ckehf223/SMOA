// 프론트 모듈 등록 위치. 서버의 ModulesConfig(backend)에 등록된 moduleId 와 같은 키를 쓴다.
// 새 모듈을 붙이려면: (1) backend ModulesConfig 에 모듈 Bean 등록 (2) 여기에 키와 스크립트 경로 추가
// (3) frontend/assets/modules/<id>.js 에서 mount(context) 를 export. 절차는 docs/MODULE_INTEGRATION_GUIDE.md.
export const MODULES = {
  identity: '/assets/modules/identity.js',
  analytics: '/assets/modules/analytics.js',
  records: '/assets/modules/records.js',
  afterReport: '/assets/modules/after-report.js',
  socialing: '/assets/modules/socialing.js',
  calling: '/assets/modules/calling.js',
  callingSheet: '/assets/modules/calling-sheet.js',
  imports: '/assets/modules/imports.js',
  goals: '/assets/modules/goals.js',
  organization: '/assets/modules/organization.js',
};
