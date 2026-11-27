// 데이터 연결 전 프로그램의 공통 화면. 가짜 숫자·빈 목록(성공 200)으로 완료처럼 보이지 않게 하고,
// 서버의 모듈 상태(/api/programs/{id}/module)와 내 권한만 보여 준다. 구현 세부(클래스·SQL)는 보여 주지 않는다.
import { clear, errorMessage, h, notice } from './ui.js';

const ACTION_LABEL = { access: '접근', read: '조회', write: '저장', export: '내보내기' };

export async function mountNotConnected(ctx, planned = []) {
  const root = clear(ctx.container);
  let status;
  try {
    status = await ctx.api.get(`/api/programs/${encodeURIComponent(ctx.programId)}/module`);
  } catch (error) {
    root.append(notice('error', errorMessage(error)));
    return;
  }
  if (status.connected) {
    root.append(notice('ok', '이 프로그램은 연결되어 있지만 전용 화면이 아직 없습니다.'));
    return;
  }
  root.append(notice('warn', '데이터 연결 준비 중입니다. 사용자 테이블이 연결되면 이 화면에서 사용할 수 있습니다.'));
  const allowed = Object.entries(ctx.permissions || {}).filter(([, on]) => on).map(([key]) => ACTION_LABEL[key]);
  root.append(h('div', { class: 'panel' },
    h('p', {}, h('strong', { text: '내 권한: ' }), allowed.join(', ') || '없음'),
    planned.length ? h('div', {}, h('strong', { text: '이 화면에서 제공될 기능' }),
      h('ul', {}, planned.map((item) => h('li', { text: item })))) : null));
}
