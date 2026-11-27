import { downloadFile, getJson, h, nameOf, runShell, toast } from './common.js';
import { organizationViews } from './organization.js';
import { callingViews } from './calling.js';
import { socialingViews } from './socialing.js';
import { dailyViews } from './daily.js';
import { reportsViews } from './reports.js';
import { recordsViews } from './records.js';
import { analyticsViews } from './analytics.js';
import { dashboardView } from './dashboard.js';
import { createPersonDialog, editPersonDialog, openPersonDetail } from './person-details.js';

// 4.0.41 지역 대시보드(주별·월별 성과 개요, 활동분석, 목표). 화면 코드는 dashboard.js에 있다.
const dashboard = dashboardView;

async function people(box, me) {
  const perm = me.perms.people;
  const state = { q: '', districtId: '', stageId: '', status: '', page: 1 };
  const STATUS_CHOICES = [{ id: 'active', name: '진행' }, { id: 'dropped', name: '탈락' }];
  const results = h('div');

  const select = (name, label, options, value) =>
    h('label', null, label, h('select', { name, value }, h('option', { value: '' }, '전체'),
      options.map((o) => h('option', { value: o.id }, o.active === false ? `${o.name} (사용 안 함)` : o.name))));
  const qInput = h('input', { type: 'search', name: 'q', maxlength: '100', placeholder: '이름·식별번호·인도자·찾기 장소·담당자·비고', 'aria-label': '대상자 검색: 이름·식별번호·인도자·찾기 장소·담당자·비고' });
  const districtSel = select('districtId', '구역', me.districts, '');
  const stageSel = select('stageId', '단계', me.stages, '');
  const statusSel = select('status', '상태', STATUS_CHOICES, '');
  const params = () => new URLSearchParams(Object.entries(state).filter(([k, v]) => v && k !== 'page'));

  async function load() {
    const qs = new URLSearchParams(params());
    qs.set('page', state.page);
    try {
      const data = await getJson(`/api/people?${qs}`);
      state.page = data.page;
      results.replaceChildren(table(data));
    } catch (err) {
      results.replaceChildren(h('p', { class: 'status error', role: 'alert' }, err.message));
    }
  }

  function table(data) {
    if (!data.items.length) return h('div', { class: 'card empty' }, '조건에 맞는 대상자가 없습니다.');
    const head = ['식별번호', '이름', '구역', '단계', '상태', '분류', '등록일', '담당자'];
    return h('div', null,
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '대상자 목록' },
        h('table', null,
          h('thead', null, h('tr', null, head.map((t) => h('th', { scope: 'col' }, t)), perm.write ? h('th', { scope: 'col' }, '관리') : null)),
          h('tbody', null, data.items.map((p) => h('tr', null,
            h('td', { class: 'code' }, p.code),
            h('td', { class: 'strong' }, h('button', { type: 'button', class: 'link', 'aria-haspopup': 'dialog', onclick: () => showDetail(p.id) }, p.name)),
            h('td', null, nameOf(me.districts, p.districtId)),
            h('td', null, h('span', { class: 'pill' }, nameOf(me.stages, p.stageId))),
            h('td', null, h('span', { class: p.status === 'dropped' ? 'pill off' : 'pill' }, p.status === 'dropped' ? '탈락' : '진행')),
            h('td', null, `${p.classification1} · ${p.classification2}`),
            h('td', null, p.registeredDate),
            h('td', null, p.worker),
            perm.write ? h('td', null, h('button', { type: 'button', class: 'secondary', onclick: () => editPersonDialog(p.id, me, { onSaved: load }) }, '수정')) : null))))),
      h('div', { class: 'pager' },
        h('button', { type: 'button', class: 'secondary', disabled: data.page <= 1, onclick: () => { state.page--; load(); } }, '이전'),
        h('span', null, `${data.page} / ${data.pages} 쪽 · 총 ${data.total}명`),
        h('button', { type: 'button', class: 'secondary', disabled: data.page >= data.pages, onclick: () => { state.page++; load(); } }, '다음')));
  }

  // 상세 대화상자: 삭제·수정·탈락/복귀 뒤에는 목록을 다시 불러온다.
  const showDetail = (id) => openPersonDetail(id, me, { onChange: load });

  async function download() {
    try {
      await downloadFile(`/api/people/export?${params()}`, 'smoa-people.xlsx');
      toast('엑셀 파일을 내려받았습니다.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const form = h('form', { class: 'toolbar', role: 'search', onsubmit: (e) => {
    e.preventDefault();
    Object.assign(state, {
      q: qInput.value.trim(),
      districtId: districtSel.querySelector('select').value,
      stageId: stageSel.querySelector('select').value,
      status: statusSel.querySelector('select').value,
      page: 1,
    });
    load();
  } },
  h('label', null, '검색', qInput), districtSel, stageSel, statusSel,
  h('div', { class: 'actions' },
    h('button', { type: 'submit' }, '조회'),
    h('button', { type: 'reset', class: 'secondary', onclick: () => { Object.assign(state, { q: '', districtId: '', stageId: '', status: '', page: 1 }); setTimeout(load); } }, '초기화')));

  box.append(
    h('div', { class: 'toolbar' }, h('h1', null, '대상자 관리'), h('span', { class: 'spacer' }),
      h('div', { class: 'actions' },
        perm.export ? h('button', { type: 'button', class: 'secondary', onclick: download }, '엑셀 내보내기') : null,
        perm.write ? h('button', { type: 'button', onclick: () => createPersonDialog(me, { onSaved: load }) }, '대상자 등록') : null)),
    h('div', { class: 'card' }, form),
    results);
  await load();
}

// 화면ID → (container, me) 함수. 기능 모듈은 위에서 정적으로 불러오므로, 파일이 없거나 문법 오류가 있으면
// 조용히 건너뛰지 않고 브라우저 콘솔에 모듈 이름과 함께 오류가 그대로 나타난다.
// 화면을 바꾸려면 해당 모듈 파일을 고치고, 새 화면은 import와 아래 목록에 함께 추가한다.
const views = {
  dashboard,
  people,
  ...organizationViews,
  ...callingViews,
  ...socialingViews,
  ...dailyViews,
  ...reportsViews,
  ...recordsViews,
  ...analyticsViews,
};

// 화면 코드가 있는 메뉴만 보여 준다(권한은 서버가 정한다).
runShell({ navOf: (me) => me.menu.filter((i) => views[i.id]), views });
