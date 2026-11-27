// analytics 모듈 화면 진입점. 데이터 연결 전에는 '데이터 연결 준비 중' 상태만 보여 준다(가짜 수치 없음).
// 데이터 연결 시 이 파일의 mount 에서 /api/programs/{programId}/data/** 응답을 렌더링한다(docs/MODULE_INTEGRATION_GUIDE.md).
import { mountNotConnected } from '../js/placeholder.js';

const PLANNED = {
  dashboard: ['기간·구역 필터 현황 카드', '단계별 인원 흐름', '활동 요약'],
  regionData: ['구역별 단계·활동 집계', '월 단위 조회와 엑셀 내보내기'],
  memberData: ['개인별 활동·단계 집계', '열 설정과 엑셀 내보내기'],
  classData: ['반별 집계와 엑셀 내보내기'],
  findingStats: ['찾기·주관자 통계', '기간 비교와 엑셀 내보내기'],
  diagnostics: ['통계 진단(누락·이상 값 점검)'],
  stagePerformance: ['단계 강약 분석과 상세 보기', '엑셀 내보내기'],
  socialingStats: ['소셜링 데이터 현황'],
  callingStats: ['콜링 데이터 현황(회차·미연결)'],
};

export async function mount(ctx) {
  if (ctx.programId === 'dashboard') return (await import('./dashboard.js')).mount(ctx);
  if (ctx.programId === 'regionData') return (await import('./region-data.js')).mount(ctx);
  if (ctx.programId === 'findingStats') return (await import('./finding-stats.js')).mount(ctx);
  if (ctx.programId === 'diagnostics') return (await import('./diagnostics.js')).mount(ctx);
  if (['memberData', 'classData', 'stagePerformance'].includes(ctx.programId)) return (await import('./performance.js')).mount(ctx);
  if (ctx.programId === 'callingStats') return (await import('./calling.js')).mount(ctx);
  if (ctx.programId === 'socialingStats') return (await import('./socialing.js')).mount(ctx);
  await mountNotConnected(ctx, PLANNED[ctx.programId] || []);
}
