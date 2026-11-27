import { downloadFile, formDialog, getJson, h, postXlsx, sendJson, toast } from './common.js';

/** 조직·구성원과 구역·반 목표 화면. 서버(/api/organization, /api/goals)가 사용자 구역 범위로 자른 자료만 준다. */

const PAGE_SIZE = 50;
const DAY = 86_400_000;
const opt = (value, label, current) => h('option', { value, selected: value === current }, label);
const field = (label, control, cls) => h('label', { class: cls }, label, control);
const todayLocal = () => new Date().toLocaleDateString('sv');
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const failed = (err) => toast(err.message, 'error');
const th = (t) => h('th', { scope: 'col' }, t);

/** anchor 날짜가 속한 주(weekStart 요일 시작) 또는 달의 처음과 끝. 서버의 periodRange와 같은 규칙이다. */
function periodRange(unit, anchor, weekStart = 0) {
  const t = Date.parse(`${anchor}T00:00:00Z`);
  if (unit === 'week') {
    const start = t - ((new Date(t).getUTCDay() - weekStart + 7) % 7) * DAY;
    return { from: isoDay(start), to: isoDay(start + 6 * DAY) };
  }
  const d = new Date(t);
  return { from: isoDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), to: isoDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)) };
}

const stat = (value, unit, caption) => h('div', { class: 'card stat' }, h('div', { class: 'num' }, `${value}${unit}`), h('div', { class: 'cap' }, caption));

function pager(page, total, onPage) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return h('div', { class: 'pager' },
    h('span', null, `전체 ${total.toLocaleString('ko-KR')}건 · ${Math.min(page, pages)} / ${pages} 페이지`),
    h('button', { type: 'button', class: 'secondary small', disabled: page <= 1, onclick: () => onPage(page - 1) }, '이전'),
    h('button', { type: 'button', class: 'secondary small', disabled: page >= pages, onclick: () => onPage(page + 1) }, '다음'));
}

async function organization(box, me) {
  const perm = me.perms.organization;
  const canEdit = perm.write && me.isAdmin; // 조직 쓰기와 엑셀 가져오기는 관리자 전용(서버도 같은 규칙)
  const state = { unitId: '', q: '', status: '', className: '', employment: '', page: 1 };
  const collapsed = new Set();
  let data;
  let byId;
  let childrenOf;

  function index() {
    byId = new Map(data.nodes.map((n) => [n.id, n]));
    childrenOf = new Map();
    for (const n of data.nodes) if (n.parentId) childrenOf.set(n.parentId, [...(childrenOf.get(n.parentId) ?? []), n]);
  }
  /** 조직과 그 하위 조직의 ID. 이름이 아니라 상위 연결로 계산한다. */
  function subtree(id) {
    const out = new Set();
    const walk = (x) => {
      if (out.has(x)) return;
      out.add(x);
      for (const c of childrenOf.get(x) ?? []) walk(c.id);
    };
    walk(id);
    return out;
  }
  const totalMembers = (id) => [...subtree(id)].reduce((sum, x) => sum + (byId.get(x)?.memberCount ?? 0), 0);

  const metricsBox = h('div', { class: 'cards' });
  const treeBox = h('div');
  const infoBox = h('div');
  const countEl = h('p', { class: 'note', 'aria-live': 'polite' });
  const membersBox = h('div');

  async function refresh() {
    data = await getJson('/api/organization');
    index();
    if (state.unitId && !byId.has(state.unitId)) state.unitId = '';
    renderAll();
  }

  // ---- 조직 구조 (접고 펴기, 선택)
  function renderTree() {
    const rows = [];
    let skipBelow = null;
    for (const n of data.nodes) {
      if (skipBelow !== null && n.depth > skipBelow) continue;
      skipBelow = null;
      const hasKids = childrenOf.has(n.id);
      if (hasKids && collapsed.has(n.id)) skipBelow = n.depth;
      const selected = state.unitId === n.id;
      rows.push(h('tr', null,
        h('td', null, h('span', { class: `indent indent-${n.depth}` },
          hasKids
            ? h('button', { type: 'button', class: 'secondary small', 'aria-expanded': String(!collapsed.has(n.id)), 'aria-label': `${n.name} ${collapsed.has(n.id) ? '펼치기' : '접기'}`, onclick: () => { collapsed.has(n.id) ? collapsed.delete(n.id) : collapsed.add(n.id); renderTree(); } }, collapsed.has(n.id) ? '▸' : '▾')
            : null,
          ' ', h('span', { class: 'strong' }, n.name)),
        n.context ? h('span', { class: 'pill off' }, '상위(참고)') : null,
        n.linked ? h('span', { class: 'pill' }, '구역 연동') : null),
        h('td', null, n.type),
        h('td', null, n.leaderName ? `${n.leaderName} (${n.leaderTitle})` : '-'),
        h('td', null, `${n.memberCount}명 (하위 포함 ${totalMembers(n.id)}명)`),
        h('td', null, h('span', { class: `pill ${n.active ? '' : 'off'}` }, n.active ? '사용' : '보관')),
        h('td', null, h('div', { class: 'row-actions' },
          n.context ? null : h('button', { type: 'button', class: 'secondary small', 'aria-pressed': String(selected), onclick: () => { state.unitId = selected ? '' : n.id; state.page = 1; renderTree(); renderInfo(); renderMembers(); } }, selected ? '선택 해제' : '구성원 보기'),
          canEdit ? h('button', { type: 'button', class: 'secondary small', onclick: () => nodeForm(n) }, '수정') : null,
          canEdit && !n.linked ? h('button', { type: 'button', class: 'danger small', onclick: () => removeNode(n) }, '삭제') : null))));
    }
    treeBox.replaceChildren(rows.length
      ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '조직 구조' }, h('table', null,
        h('thead', null, h('tr', null, ['조직', '유형', '책임자', '구성원', '상태', '관리'].map(th))), h('tbody', null, rows)))
      : h('div', { class: 'card empty' }, '등록된 조직이 없습니다.'));
  }

  function renderInfo() {
    const n = byId.get(state.unitId);
    infoBox.replaceChildren(n
      ? h('div', { class: 'card' }, h('h2', null, n.name), h('p', { class: 'note' }, n.path),
        h('p', null, `유형 ${n.type} · ${n.leaderTitle} ${n.leaderName || '미지정'} · 일보 구역명 ${n.reportRegion || '상위 구역 사용'}`))
      : null);
  }

  // ---- 구성원 명부 (조직 선택 + 상태·반·직업 구분·검색 필터, 50명씩)
  function choices(key) {
    const labelKey = key === 'className' ? 'classLabel' : 'employmentLabel';
    const map = new Map(data.options[key].map((o) => [o.value, o.label]));
    for (const m of data.members) if (!map.has(m[key])) map.set(m[key], m[labelKey] || '미지정');
    return [...map].map(([value, label]) => [`:${value}`, label]);
  }
  function filtered() {
    const ids = state.unitId ? subtree(state.unitId) : null;
    const q = state.q.toLowerCase();
    return data.members.filter((m) =>
      (!ids || ids.has(m.unitId)) &&
      (!state.status || m.status === state.status) &&
      (!state.className || state.className === `:${m.className}`) &&
      (!state.employment || state.employment === `:${m.employment}`) &&
      (!q || [m.code, m.name, m.positionLabel, m.unitPath].join(' ').toLowerCase().includes(q)));
  }
  function renderMembers() {
    const all = filtered();
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const rows = all.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    countEl.textContent = `${state.unitId ? '선택한 조직과 하위 조직 · ' : '전체 · '}${all.length.toLocaleString('ko-KR')}명`;
    membersBox.replaceChildren(rows.length
      ? h('div', null,
        h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '구성원 목록' }, h('table', null,
          h('thead', null, h('tr', null, ['이름', '구성원ID', '소속', '직책 · 책임', '반', '직업 구분', '연결 대상자', '상태'].map(th), canEdit ? th('관리') : null)),
          h('tbody', null, rows.map((m) => h('tr', null,
            h('td', { class: 'strong' }, m.name), h('td', { class: 'code' }, m.code), h('td', null, m.unitPath),
            h('td', null, [m.positionLabel, ...m.leads].filter(Boolean).join(' · ') || '-'),
            h('td', null, m.classLabel || '미지정'), h('td', null, m.employmentLabel || '-'), h('td', null, `${m.linkedPeople}명`),
            h('td', null, h('span', { class: `pill ${m.status === 'active' ? '' : 'off'}` }, m.status === 'active' ? '활동' : '보관')),
            canEdit ? h('td', null, h('div', { class: 'row-actions' },
              h('button', { type: 'button', class: 'secondary small', onclick: () => memberForm(m) }, '수정'),
              h('button', { type: 'button', class: 'danger small', onclick: () => removeMember(m) }, '삭제'))) : null))))),
        pager(state.page, all.length, (p) => { state.page = p; renderMembers(); }))
      : h('div', { class: 'card empty' }, '조건에 맞는 구성원이 없습니다. 조직을 바꾸거나 검색 조건을 지워 보세요.'));
  }

  function renderAll() {
    metricsBox.replaceChildren(stat(data.metrics.nodes, '개', '사용 중인 조직'), stat(data.metrics.members, '명', '구성원'), stat(data.metrics.linkedPeople, '명', '인도자가 연결된 대상자'));
    renderTree();
    renderInfo();
    renderMembers();
  }

  // ---- 조직 쓰기 (관리자)
  function nodeForm(node) {
    const linked = node?.linked === true;
    const blocked = node ? subtree(node.id) : new Set();
    const within = node ? subtree(node.id) : new Set();
    const first = !data.nodes.length;
    const initial = node ?? { parentId: state.unitId, type: first ? '지역' : '구역', leaderTitle: first ? '지역장' : '구역장', active: true };
    formDialog({
      title: node ? `조직 수정 · ${node.name}` : '조직 추가',
      body: h('div', { class: 'form-grid' },
        field('조직ID', h('input', { type: 'text', name: 'code', value: node?.code ?? '', disabled: !!node, maxlength: '60', placeholder: '비워 두면 자동 부여' })),
        field('이름 (필수)', h('input', { type: 'text', name: 'name', value: node?.name ?? '', required: true, maxlength: '60', disabled: linked })),
        field('유형 (직접 입력 가능)', h('input', { type: 'text', name: 'type', value: initial.type, required: true, maxlength: '30', list: 'org-types', disabled: linked })),
        field('상위 조직', h('select', { name: 'parentId' }, opt('', '(최상위)', initial.parentId ?? ''),
          data.nodes.filter((n) => !blocked.has(n.id) && (n.active || n.id === node?.parentId)).map((n) => opt(n.id, n.path, initial.parentId ?? '')))),
        field('책임자 (소속·하위 조직의 활동 구성원)', h('select', { name: 'leaderId' }, opt('', '(없음)', initial.leaderId ?? ''),
          data.members.filter((m) => m.status === 'active' && within.has(m.unitId)).map((m) => opt(m.id, `${m.name} (${m.code})`, initial.leaderId ?? '')))),
        field('책임자 호칭', h('input', { type: 'text', name: 'leaderTitle', value: initial.leaderTitle, maxlength: '40' })),
        field('데이터 구역명', h('input', { type: 'text', name: 'reportRegion', value: node?.reportRegion ?? '', maxlength: '60', disabled: linked, placeholder: '구역 일보·목표의 구역 이름' })),
        field('상태', h('select', { name: 'active', disabled: linked }, opt('true', '사용', String(initial.active)), opt('false', '보관', String(initial.active)))),
        h('datalist', { id: 'org-types' }, ['지역', '구역', '반', '팀', '부서'].map((v) => h('option', { value: v }))),
        linked ? h('p', { class: 'note wide' }, '이 조직은 구역 범위와 연동되어 있어 이름·유형·구역명·상태를 바꾸거나 삭제할 수 없습니다.') : null,
        !node ? h('p', { class: 'note wide' }, '유형이 구역이면 일보 구역명은 조직 이름으로 자동 설정됩니다. 책임자는 구성원을 등록한 뒤 조직 수정에서 지정합니다.') : null),
      onSubmit: async (fd) => {
        const body = Object.fromEntries(fd);
        if (body.active !== undefined) body.active = body.active === 'true';
        await sendJson(node ? 'PUT' : 'POST', node ? `/api/organization/nodes/${encodeURIComponent(node.id)}` : '/api/organization/nodes', body);
        toast(node ? '조직을 수정했습니다.' : '조직을 추가했습니다.');
        await refresh();
      },
    });
  }

  async function removeNode(n) {
    if (!confirm(`'${n.name}' 조직을 삭제할까요? 하위 조직·구성원·연결 기록·목표가 없을 때만 삭제됩니다. 삭제 전 내용은 변경 이력에 남습니다.`)) return;
    try {
      await sendJson('DELETE', `/api/organization/nodes/${encodeURIComponent(n.id)}`);
      toast('삭제했습니다.');
      await refresh();
    } catch (err) { failed(err); }
  }

  function memberForm(m) {
    // 보관되어 목록에서 빠진 기존 값은 그대로 남겨, 저장할 때 값이 몰래 바뀌지 않게 한다.
    const choice = (list, cur, blank) => [
      blank ? opt('', blank, cur ?? '') : null,
      list.map((o) => opt(o.value, o.label, cur)),
      cur && !list.some((o) => o.value === cur) ? opt(cur, `${cur} (기존 값)`, cur) : null,
    ];
    const units = data.nodes.filter((n) => !n.context && (n.active || n.id === m?.unitId));
    const unitSel = h('select', { name: 'unitId', required: true }, units.map((n) => opt(n.id, n.path, m?.unitId ?? state.unitId)));
    // 소속을 바꿀 때만 발령일·사유를 받는다.
    const transfer = h('div', { class: 'wide', hidden: true }, h('div', { class: 'form-grid' },
      field('발령일', h('input', { type: 'date', name: 'transferDate', value: todayLocal() })),
      field('발령 사유 (선택)', h('input', { type: 'text', name: 'transferReason', maxlength: '200' }))));
    unitSel.addEventListener('change', () => { transfer.hidden = !m || unitSel.value === m.unitId; });
    const history = h('div');
    let loaded = false;
    const transfers = m ? h('details', { class: 'wide', ontoggle: async (e) => {
      if (!e.target.open || loaded) return;
      loaded = true;
      try {
        const { items } = await getJson(`/api/organization/members/${encodeURIComponent(m.id)}/transfers`);
        history.replaceChildren(items.length
          ? h('ul', null, items.map((t) => h('li', null, `${t.date} · ${t.fromPath} → ${t.toPath} · ${t.reason} (${t.actor})`)))
          : h('p', { class: 'note' }, '아직 소속 변경 이력이 없습니다.'));
      } catch (err) {
        loaded = false;
        history.replaceChildren(h('p', { class: 'status error', role: 'alert' }, err.message));
      }
    } }, h('summary', null, '발령·소속 변경 이력'), history) : null;
    formDialog({
      title: m ? `구성원 수정 · ${m.name}` : '구성원 추가',
      body: h('div', { class: 'form-grid' },
        field('구성원ID', h('input', { type: 'text', name: 'code', value: m?.code ?? '', disabled: !!m, maxlength: '60', placeholder: '비워 두면 자동 부여' })),
        field('이름 (필수)', h('input', { type: 'text', name: 'name', value: m?.name ?? '', required: true, maxlength: '100' })),
        field('소속 조직', unitSel),
        field('직책', h('select', { name: 'position' }, choice(data.options.position, m?.position))),
        field('반', h('select', { name: 'className' }, choice(data.options.className, m?.className, '(없음)'))),
        field('직업 구분', h('select', { name: 'employment' }, choice(data.options.employment, m?.employment))),
        field('상태', h('select', { name: 'status' }, opt('active', '활동', m?.status ?? 'active'), opt('inactive', '보관', m?.status ?? 'active'))),
        field('비고', h('textarea', { name: 'notes', maxlength: '5000', value: m?.notes ?? '' }), 'wide'),
        transfer, transfers,
        h('p', { class: 'note wide' }, '소속을 옮기거나 보관하면 맡고 있던 조직 책임자 지정이 해제되고 이력에 남습니다. 실제 책임자는 조직 수정에서 지정합니다.')),
      onSubmit: async (fd) => {
        await sendJson(m ? 'PUT' : 'POST', m ? `/api/organization/members/${encodeURIComponent(m.id)}` : '/api/organization/members', Object.fromEntries(fd));
        toast(m ? '구성원을 수정했습니다.' : '구성원을 추가했습니다.');
        await refresh();
      },
    });
  }

  async function removeMember(m) {
    if (!confirm(`'${m.name}' 구성원을 삭제할까요? 대상자·활동·일보에 연결되어 있으면 삭제되지 않으니 그때는 상태를 '보관'으로 바꿔 주세요.`)) return;
    try {
      await sendJson('DELETE', `/api/organization/members/${encodeURIComponent(m.id)}`);
      toast('삭제했습니다.');
      await refresh();
    } catch (err) { failed(err); }
  }

  // ---- 구성원 반 일괄 지정 (구역 선택 → 체크한 구성원만 저장, 한꺼번에 적용 가능)
  function classesForm() {
    const districts = data.nodes.filter((n) => !n.context && (n.reportRegion || /구역/.test(n.type)));
    if (!districts.length) return toast('반을 지정할 구역이 없습니다.', 'error');
    const selected = districts.some((n) => n.id === state.unitId) ? state.unitId : districts[0].id;
    const districtSel = h('select', { name: 'districtId' }, districts.map((n) => opt(n.id, n.name, selected)));
    const classChoices = (cur) => [opt('', '(없음)', cur), data.options.className.map((o) => opt(o.value, o.label, cur))];
    const applySel = h('select', { name: 'batchClass', 'aria-label': '선택한 구성원에 적용할 반' }, classChoices(''));
    const list = h('div');
    let controls = [];
    const draw = () => {
      const ids = subtree(districtSel.value);
      const rows = data.members.filter((m) => ids.has(m.unitId));
      controls = rows.map((m) => ({
        m,
        pick: h('input', { type: 'checkbox', name: `pick:${m.id}`, checked: true, 'aria-label': `${m.name} 선택` }),
        cls: h('select', { name: `m:${m.id}`, 'aria-label': `${m.name} 반` }, classChoices(m.className)),
      }));
      list.replaceChildren(rows.length
        ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '반 지정 대상' }, h('table', null,
          h('thead', null, h('tr', null, ['선택', '구성원', '소속', '반'].map(th))),
          h('tbody', null, controls.map(({ m, pick, cls }) => h('tr', null,
            h('td', null, pick), h('td', null, `${m.name}${m.status === 'active' ? '' : ' (보관)'}`), h('td', null, m.unitPath), h('td', null, cls))))))
        : h('p', { class: 'note' }, '이 구역에 구성원이 없습니다.'));
    };
    districtSel.addEventListener('change', draw);
    draw();
    formDialog({
      title: '구성원 반 일괄 지정',
      body: h('div', null,
        h('div', { class: 'form-grid' }, field('구역', districtSel), field('선택한 구성원에 적용할 반', applySel),
          h('div', null, h('button', { type: 'button', class: 'secondary', onclick: () => controls.filter((c) => c.pick.checked).forEach((c) => { c.cls.value = applySel.value; }) }, '선택한 행에 적용'))),
        h('p', { class: 'note' }, '체크한 행만 저장되며, 구역 밖 구성원은 바뀌지 않습니다. 행마다 다른 반을 지정할 수도 있습니다.'), list),
      submitLabel: '선택한 구성원 반 저장',
      onSubmit: async () => {
        const rows = controls.filter((c) => c.pick.checked && c.cls.value !== c.m.className).map((c) => ({ memberId: c.m.id, className: c.cls.value }));
        if (!rows.length) throw new Error('바뀐 구성원이 없습니다.');
        const res = await sendJson('POST', '/api/organization/classes', { districtId: districtSel.value, rows });
        toast(`${res.changed}명의 반을 지정했습니다.`);
        await refresh();
      },
    });
  }

  // ---- 엑셀 가져오기 (관리자): 조직·구성원 시트만, 미리보기를 확인한 뒤 한 번에 반영
  function importForm() {
    const file = h('input', { type: 'file', name: 'file', accept: '.xlsx' });
    const result = h('div');
    let previewId = null;
    const reset = () => { previewId = null; result.replaceChildren(); };
    file.addEventListener('change', reset);
    const show = (p) => {
      const c = p.counts;
      result.replaceChildren(
        h('p', { class: 'note' }, `조직 신규 ${c.조직신규}건 · 수정 ${c.조직수정}건 / 구성원 신규 ${c.구성원신규}건 · 수정 ${c.구성원수정}건 / 변경 없음 ${c.변경없음}건`),
        p.errors.length ? h('ul', { class: 'status error', role: 'alert' }, p.errors.map((e) => h('li', null, e)), p.totalErrors > p.errors.length ? h('li', null, `그 밖의 오류 ${p.totalErrors - p.errors.length}건`) : null) : null,
        p.changes.length
          ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '가져오기 변경 내용' }, h('table', null,
            h('thead', null, h('tr', null, ['구분', '처리', 'ID', '이름', '바뀌는 항목'].map(th))),
            h('tbody', null, p.changes.map((x) => h('tr', null, h('td', null, x.kind), h('td', null, x.status), h('td', { class: 'code' }, x.code), h('td', null, x.name),
              h('td', { class: 'wrapcell' }, x.fields.map((f) => (f.before === undefined ? f.field : `${f.field}: ${f.before || '(없음)'} → ${f.after || '(없음)'}`)).join(', ') || '-'))))))
          : null,
        p.totalChanges > p.changes.length ? h('p', { class: 'note' }, `변경 ${p.totalChanges}건 중 ${p.changes.length}건만 표시했습니다.`) : null,
        h('p', { class: 'note' }, p.canApply ? `확인 후 아래 반영을 누르세요. 미리보기는 약 ${Math.round(p.expiresInSeconds / 60)}분 동안 유효하며, 그 사이 조직이 바뀌면 다시 만들어야 합니다.` : '반영할 수 없습니다. 오류를 고친 파일로 다시 미리보기를 만들어 주세요.'));
    };
    formDialog({
      title: '조직·구성원 엑셀 가져오기',
      submitLabel: '미리보기 내용 반영',
      body: h('div', null,
        h('p', { class: 'note' }, '“조직 엑셀 양식”으로 내려받은 파일의 조직·구성원 시트만 읽습니다. 구역과 연동된 조직(1~3구역)의 이름·유형·구역명·상태는 바뀌지 않고, 엑셀에 없는 조직·구성원은 삭제되지 않습니다.'),
        h('div', { class: 'toolbar' }, field('엑셀 파일 (.xlsx)', file),
          h('div', { class: 'actions' }, h('button', { type: 'button', onclick: async (e) => {
            const button = e.currentTarget;
            const chosen = file.files?.[0];
            if (!chosen) return toast('엑셀 파일을 선택해 주세요.', 'error');
            button.disabled = true;
            reset();
            try {
              const p = await postXlsx('/api/organization/import/preview', chosen);
              previewId = p.previewId;
              show(p);
            } catch (err) {
              result.replaceChildren(h('p', { class: 'status error', role: 'alert' }, err.message));
            } finally { button.disabled = false; }
          } }, '미리보기'))),
        result),
      onSubmit: async () => {
        if (!previewId) throw new Error('오류 없이 반영할 수 있는 미리보기를 먼저 만들어 주세요.');
        const res = await sendJson('POST', '/api/organization/import/apply', { previewId });
        previewId = null;
        toast(`조직·구성원 ${res.applied}건을 반영했습니다.`);
        await refresh();
      },
    });
  }

  const search = h('input', { type: 'search', name: 'q', maxlength: '100', placeholder: '이름·구성원ID·직책·조직', 'aria-label': '구성원 검색' });
  search.addEventListener('input', () => { state.q = search.value.trim(); state.page = 1; renderMembers(); });
  const filterSelect = (name, label, key, list) => {
    const sel = h('select', { name }, opt('', '전체', ''), list.map(([value, text]) => opt(value, text, '')));
    sel.addEventListener('change', () => { state[key] = sel.value; state.page = 1; renderMembers(); });
    return field(label, sel);
  };

  data = await getJson('/api/organization');
  index();
  box.append(
    h('div', { class: 'toolbar' }, h('h1', null, '조직·구성원'), h('span', { class: 'spacer' }),
      h('div', { class: 'actions' },
        perm.export ? h('button', { type: 'button', class: 'secondary', onclick: () => downloadFile('/api/organization/export', 'smoa-organization.xlsx').then(() => toast('엑셀 파일을 내려받았습니다.'), failed) }, '엑셀 내보내기') : null,
        canEdit ? h('button', { type: 'button', class: 'secondary', onclick: () => downloadFile('/api/organization/template', 'smoa-organization-template.xlsx').then(() => toast('조직 엑셀 양식을 내려받았습니다.'), failed) }, '조직 엑셀 양식') : null,
        canEdit ? h('button', { type: 'button', class: 'secondary', onclick: importForm }, '엑셀 가져오기') : null,
        canEdit ? h('button', { type: 'button', class: 'secondary', onclick: classesForm }, '반 일괄 지정') : null,
        canEdit ? h('button', { type: 'button', class: 'secondary', onclick: () => memberForm(null) }, '구성원 추가') : null,
        canEdit ? h('button', { type: 'button', onclick: () => nodeForm(null) }, '조직 추가') : null)),
    h('p', { class: 'note' }, canEdit
      ? '조직과 구성원은 관리자만 수정합니다. 구역과 연동된 조직(1~3구역)은 이름을 바꾸거나 삭제할 수 없습니다. 조직을 먼저 등록한 뒤 구성원을 배치하고, 대상자의 인도자를 선택하세요.'
      : '배정된 구역의 조직과 구성원만 보이며, 조직·구성원 수정은 관리자만 할 수 있습니다.'),
    metricsBox,
    h('h2', null, '조직 구조'), treeBox, infoBox,
    h('div', { class: 'toolbar' }, h('h2', null, '구성원 명부'), h('span', { class: 'spacer' })),
    h('div', { class: 'toolbar', role: 'search' },
      field('검색', search),
      filterSelect('status', '상태', 'status', [['active', '활동'], ['inactive', '보관']]),
      filterSelect('className', '반', 'className', choices('className')),
      filterSelect('employment', '직업 구분', 'employment', choices('employment'))),
    countEl, membersBox);
  renderAll();
}

async function goals(box, me) {
  const perm = me.perms.goals;
  const today = todayLocal();
  const first = await getJson(`/api/goals?${new URLSearchParams({ from: `${today.slice(0, 8)}01`, to: periodRange('month', today).to })}`);
  const weekStart = first.weekStart ?? 0;
  const state = { from: `${today.slice(0, 8)}01`, to: periodRange('month', today).to, region: '', page: 1 };
  const results = h('div');
  const stageName = (id) => (id === '*' ? '전체(찾은 인원)' : me.stages.find((s) => s.id === id)?.name ?? id);
  const qs = () => new URLSearchParams(Object.entries(state).filter(([k, v]) => k !== 'page' && v));
  const periodUnitOptions = (cur) => [opt('week', '주별', cur), opt('month', '월별', cur), opt('custom', '직접 지정', cur)];
  const stageOptions = (cur, withAll = true) => [withAll ? opt('*', '전체(찾은 인원)', cur) : null, me.stages.filter((s) => s.active || s.id === cur).map((s) => opt(s.id, `${s.name} 신규 진입`, cur))];
  const dateFields = (unit, from, to) => {
    // 주별·월별을 고르면 시작일이 속한 주·달에 맞춰 두 날짜를 채운다. 직접 지정은 그대로 둔다.
    const fill = () => {
      if (unit.value === 'custom' || !from.value) return;
      const range = periodRange(unit.value, from.value, weekStart);
      from.value = range.from;
      to.value = range.to;
    };
    unit.addEventListener('change', fill);
    from.addEventListener('change', fill);
  };
  let latest = first;

  async function load(data) {
    try {
      latest = data ?? await getJson(`/api/goals?${qs()}`);
      render();
    } catch (err) {
      results.replaceChildren(h('p', { class: 'status error', role: 'alert' }, err.message));
    }
  }

  function render() {
    const items = latest.items;
    if (!items.length) return results.replaceChildren(h('div', { class: 'card empty' }, '조건에 맞는 목표가 없습니다.'));
    const rows = items.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    results.replaceChildren(h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '목표 목록' }, h('table', null,
      h('thead', null, h('tr', null, ['구역', '반', '기간', '단위', '항목', '목표', '달성', '부족', '달성률'].map(th), perm.write ? th('관리') : null)),
      h('tbody', null, rows.map((g) => h('tr', null,
        h('td', { class: 'strong' }, g.region || '(전체 구역)'), h('td', null, g.classLabel || g.className || '-'), h('td', null, `${g.from} ~ ${g.to}`),
        h('td', null, { week: '주별', month: '월별', custom: '직접' }[g.periodUnit] ?? '직접'), h('td', null, g.stageName),
        h('td', null, String(g.target)), h('td', null, String(g.actual)), h('td', null, String(g.shortfall)),
        h('td', null, g.rate === null ? '-' : h('span', { class: 'rate' },
          h('progress', { max: 100, value: Math.min(100, Math.round(g.rate)), 'aria-label': `달성률 ${Math.round(g.rate)}%` }), ` ${Math.round(g.rate)}%`)),
        perm.write ? h('td', null, h('div', { class: 'row-actions' },
          h('button', { type: 'button', class: 'secondary small', onclick: () => edit(g) }, '수정'),
          h('button', { type: 'button', class: 'danger small', onclick: () => remove(g) }, '삭제'))) : null))))),
    pager(state.page, items.length, (p) => { state.page = p; render(); }));
  }

  // ---- 목표 한 건 추가·수정 (기존 동작)
  function edit(g) {
    const regions = first.anyRegionAllowed ? ['', ...first.regions] : first.regions;
    const from = h('input', { type: 'date', name: 'from', value: g?.from ?? state.from, required: true });
    const to = h('input', { type: 'date', name: 'to', value: g?.to ?? state.to, required: true });
    const unit = h('select', { name: 'periodUnit' }, periodUnitOptions(g?.periodUnit ?? 'month'));
    dateFields(unit, from, to);
    formDialog({
      title: g ? '목표 수정' : '목표 추가',
      body: h('div', { class: 'form-grid' },
        field('구역', h('select', { name: 'region', required: !first.anyRegionAllowed }, regions.map((r) => opt(r, r || '(구역 없음 · 반 목표)', g?.region ?? regions[0])))),
        field('반', h('select', { name: 'className' }, opt('', '(전체)', g?.className ?? ''), first.classes.map((c) => opt(c.value, c.label, g?.className)))),
        field('기간 단위', unit), field('시작일', from), field('종료일', to),
        field('항목', h('select', { name: 'stageId' }, stageOptions(g?.stageId ?? '*'))),
        field('목표 건수 (0건도 저장)', h('input', { type: 'number', name: 'target', min: '0', max: '23000000', step: '1', required: true, value: g?.target ?? '' })),
        h('p', { class: 'note wide' }, '같은 구역·반·기간·항목의 목표를 다시 저장하면 목표 건수가 바뀝니다. 달성 수는 대상자의 단계 이력으로 계산합니다.')),
      onSubmit: async (fd) => {
        await sendJson(g ? 'PUT' : 'POST', g ? `/api/goals/${encodeURIComponent(g.id)}` : '/api/goals', Object.fromEntries(fd));
        toast('저장했습니다.');
        await load();
      },
    });
  }

  async function remove(g) {
    if (!confirm(`${g.region || g.classLabel || g.className} ${g.from}~${g.to} ${stageName(g.stageId)} 목표를 삭제할까요?`)) return;
    try {
      await sendJson('DELETE', `/api/goals/${encodeURIComponent(g.id)}`);
      toast('삭제했습니다.');
      await load();
    } catch (err) { failed(err); }
  }

  // ---- 구역·반 목표 표: 기간·항목을 고르고 여러 목표를 한 번에 저장·삭제
  function matrixForm() {
    const range = periodRange('week', today, weekStart);
    const scope = h('select', { name: 'scope' }, opt('region', '구역별', 'region'), first.anyRegionAllowed ? opt('class', '반별 (구역 구분 없이 전체 합산)', 'region') : null);
    const unit = h('select', { name: 'periodUnit' }, periodUnitOptions('week'));
    const from = h('input', { type: 'date', name: 'from', value: range.from, required: true });
    const to = h('input', { type: 'date', name: 'to', value: range.to, required: true });
    const stage = h('select', { name: 'stageId' }, stageOptions('*'));
    const region = h('select', { name: 'region' }, opt('', '전체 구역', ''), first.regions.map((r) => opt(r, r, '')));
    const regionBox = h('div', null, field('구역 범위', region));
    const status = h('p', { class: 'status', role: 'status' }, '조건을 정한 뒤 “표 불러오기”를 누르세요.');
    const tableBox = h('div');
    let loaded = null;
    let controls = [];
    const invalidate = () => { loaded = null; controls = []; tableBox.replaceChildren(); status.textContent = '조건이 바뀌었습니다. “표 불러오기”를 다시 눌러 주세요.'; };
    dateFields(unit, from, to);
    for (const control of [scope, unit, from, to, stage, region]) control.addEventListener('change', invalidate);
    scope.addEventListener('change', () => { regionBox.hidden = scope.value === 'class'; });

    async function loadTable() {
      try {
        const params = new URLSearchParams({ scope: scope.value, from: from.value, to: to.value, periodUnit: unit.value, stageId: stage.value, region: scope.value === 'class' ? '' : region.value });
        const d = await getJson(`/api/goals/matrix?${params}`);
        loaded = d;
        controls = d.rows.map((r) => {
          const label = d.scope === 'class' ? r.classLabel || r.className : r.region;
          const input = h('input', { type: 'number', min: '0', max: '23000000', step: '1', value: r.target ?? '', placeholder: '미설정', 'aria-label': `${label} 목표` });
          const del = r.goalId ? h('input', { type: 'checkbox', 'aria-label': `${label} 목표 삭제`, onchange: (e) => { input.disabled = e.target.checked; } }) : null;
          return { r, label, input, del };
        });
        tableBox.replaceChildren(controls.length
          ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '목표 입력 표' }, h('table', null,
            h('thead', null, h('tr', null, [d.scope === 'class' ? '반' : '구역', '목표 건수', '삭제'].map(th))),
            h('tbody', null, controls.map((c) => h('tr', null, h('td', null, c.label), h('td', null, c.input), h('td', null, c.del ?? '—'))))))
          : h('p', { class: 'note' }, '입력할 대상이 없습니다.'));
        status.textContent = `${controls.length}개 대상 · ${d.from} ~ ${d.to}`;
      } catch (err) {
        invalidate();
        status.textContent = err.message;
      }
    }

    formDialog({
      title: '구역·반 목표 한 번에 입력',
      submitLabel: '표의 목표 한 번에 저장',
      body: h('div', null,
        h('div', { class: 'form-grid' }, field('목표 대상', scope), field('기간 단위', unit), field('시작일', from), field('종료일', to), field('목표 항목', stage), regionBox),
        h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'secondary', onclick: loadTable }, '표 불러오기'), status),
        tableBox,
        h('p', { class: 'note' }, '빈칸은 기존 목표를 그대로 둡니다. 0건 목표는 0을 입력해 저장하고, 기존 목표를 없애려면 삭제를 체크하세요.')),
      onSubmit: async () => {
        if (!loaded) throw new Error('표를 먼저 불러와 주세요.');
        const rows = controls.filter((c) => !c.del?.checked && c.input.value !== '').map((c) => ({ region: c.r.region, className: c.r.className, target: Number(c.input.value) }));
        const deleteIds = controls.filter((c) => c.del?.checked).map((c) => c.r.goalId);
        if (!rows.length && !deleteIds.length) throw new Error('저장하거나 삭제할 목표가 없습니다.');
        const res = await sendJson('POST', '/api/goals/batch', { scope: loaded.scope, from: loaded.from, to: loaded.to, periodUnit: loaded.periodUnit, stageId: loaded.stageId, version: loaded.version, rows, deleteIds });
        toast(res.changed ? `목표 ${res.saved}건 저장 · ${res.deleted}건 삭제를 반영했습니다.` : '바뀐 내용이 없습니다.');
        await load();
      },
    });
  }

  // ---- 직전 기간 목표 복사: 미리보기에서 복사·유지·제외를 확인한 뒤 한 번에 저장
  function copyForm() {
    const range = periodRange('week', today, weekStart);
    const unit = h('select', { name: 'periodUnit' }, periodUnitOptions('week'));
    const region = h('select', { name: 'regionScope' }, opt('', '전체 목표', ''), first.regions.map((r) => opt(r, r, '')));
    const from = h('input', { type: 'date', name: 'from', value: range.from, required: true });
    const to = h('input', { type: 'date', name: 'to', value: range.to, required: true });
    const conflict = h('select', { name: 'conflict' }, opt('keep', '기존 목표 유지', 'keep'), opt('overwrite', '직전 기간 값으로 덮어쓰기', 'keep'));
    const status = h('p', { class: 'status', role: 'status' }, '“복사 미리보기”를 눌러 결과를 확인하세요.');
    const result = h('div');
    let preview = null;
    const invalidate = () => { preview = null; result.replaceChildren(); status.textContent = '조건이 바뀌었습니다. “복사 미리보기”를 다시 눌러 주세요.'; };
    dateFields(unit, from, to);
    for (const control of [unit, region, from, to, conflict]) control.addEventListener('change', invalidate);
    const label = { copy: '복사', overwrite: '덮어쓰기', keep: '기존 유지', skip: '제외' };

    async function runPreview(e) {
      const button = e.currentTarget;
      button.disabled = true;
      invalidate();
      try {
        const p = await sendJson('POST', '/api/goals/copy/preview', { periodUnit: unit.value, from: from.value, to: to.value, regionScope: region.value, conflict: conflict.value });
        preview = p;
        const c = p.counts;
        status.textContent = `${p.source.from} ~ ${p.source.to} → ${p.destination.from} ~ ${p.destination.to} · 복사 ${c.copy}건 · 덮어쓰기 ${c.overwrite}건 · 기존 유지 ${c.keep}건 · 제외 ${c.skip}건`;
        result.replaceChildren(
          p.items.length
            ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '복사 미리보기' }, h('table', null,
              h('thead', null, h('tr', null, ['구역', '반', '목표 항목', '직전 목표', '저장할 기간의 기존 목표', '처리'].map(th))),
              h('tbody', null, p.items.map((i) => h('tr', null,
                h('td', null, i.region || '(전체 구역)'), h('td', null, i.classLabel || '구역 전체'), h('td', null, i.stageName), h('td', null, String(i.target)),
                h('td', null, i.current === null ? '—' : String(i.current)), h('td', null, i.reason ? `${label[i.status]} · ${i.reason}` : label[i.status]))))))
            : null,
          p.message ? h('p', { class: 'status error', role: 'alert' }, p.message) : null);
      } catch (err) {
        result.replaceChildren(h('p', { class: 'status error', role: 'alert' }, err.message));
      } finally { button.disabled = false; }
    }

    formDialog({
      title: '직전 기간 목표 복사',
      submitLabel: '복사할 목표 저장',
      body: h('div', null,
        h('div', { class: 'form-grid' }, field('기간 단위', unit), field('복사 범위', region), field('저장할 시작일', from), field('저장할 종료일', to), field('이미 있는 목표', conflict)),
        h('p', { class: 'note' }, '선택 기간의 바로 앞 주·달(직접 지정은 같은 일수)에 등록한 목표를 복사합니다. 모든 반과 목표 항목을 함께 확인하며, 보관·미등록 반과 같은 반 코드의 중복 목표는 제외합니다.'),
        h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'secondary', onclick: runPreview }, '복사 미리보기'), status),
        result),
      onSubmit: async () => {
        if (!preview?.canApply) throw new Error('복사할 목표가 있는 미리보기를 먼저 만들어 주세요.');
        const res = await sendJson('POST', '/api/goals/copy/apply', { previewId: preview.previewId });
        preview = null;
        toast(`직전 기간 목표 ${res.applied}건을 복사했습니다.`);
        await load();
      },
    });
  }

  const fromIn = h('input', { type: 'date', name: 'from', value: state.from });
  const toIn = h('input', { type: 'date', name: 'to', value: state.to });
  const regionSel = h('select', { name: 'region' }, opt('', '전체', ''), first.regions.map((r) => opt(r, r, '')));
  const form = h('form', { class: 'toolbar', role: 'search', onsubmit: (e) => {
    e.preventDefault();
    Object.assign(state, { from: fromIn.value, to: toIn.value, region: regionSel.value, page: 1 });
    load();
  } },
  field('시작일', fromIn), field('종료일', toIn), field('구역', regionSel),
  h('div', { class: 'actions' },
    h('button', { type: 'submit' }, '조회'),
    h('button', { type: 'button', class: 'secondary', onclick: () => { fromIn.value = ''; toIn.value = ''; regionSel.value = ''; Object.assign(state, { from: '', to: '', region: '', page: 1 }); load(); } }, '전체 기간')));

  box.append(
    h('div', { class: 'toolbar' }, h('h1', null, '구역·반 목표'), h('span', { class: 'spacer' }),
      h('div', { class: 'actions' },
        perm.export ? h('button', { type: 'button', class: 'secondary', onclick: () => downloadFile(`/api/goals/export?${qs()}`, 'smoa-goals.xlsx').then(() => toast('엑셀 파일을 내려받았습니다.'), failed) }, '엑셀 내보내기') : null,
        perm.write ? h('button', { type: 'button', class: 'secondary', onclick: copyForm }, '직전 기간 목표 복사') : null,
        perm.write ? h('button', { type: 'button', class: 'secondary', onclick: matrixForm }, '구역·반 목표 표 입력') : null,
        perm.write ? h('button', { type: 'button', onclick: () => edit(null) }, '목표 추가') : null)),
    h('p', { class: 'note' }, first.anyRegionAllowed ? '모든 구역의 목표를 볼 수 있습니다. 구역별 목표는 구역마다, 반별 목표는 전체 구역의 같은 반을 합산한 실적과 비교합니다.' : '배정된 구역의 목표만 보이고 저장할 수 있습니다.'),
    h('div', { class: 'card' }, form),
    results);
  await load(first);
}

export const organizationViews = { organization, goals };
