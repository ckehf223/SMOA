import { getJson, h, sendJson, toast } from './common.js';
import { countCards, dataTable, downloadFile, messageList, runBusy, setChildren, statusLine, uploadXlsx } from './daily.js';

/**
 * 보고서 화면: 결과 엑셀 내보내기(구역 범위), 데이터별 입력 양식 내려받기, 엑셀 자료 가져오기·기존 대상자 업데이트(미리보기 → 반영),
 * 입력 일계와 상세 등록 대조. 버튼은 me.perms.reports가 허용할 때만 나타나며, 구역 권한과 연락처 마스킹은 서버가 적용한다.
 */

const field = (label, control, cls) => h('label', { class: cls }, label, control);
const option = (value, label) => h('option', { value }, label);
const DEFAULT_OFF_COLUMNS = ['code', 'introducerCode'];

async function reports(box, me) {
  const perm = me.perms.reports;
  const info = await getJson('/api/reports/info');
  const panel = h('div');
  const tabs = [
    ['export', '결과 내보내기'], ['templates', '양식 내려받기'], ['import', '자료 가져오기'],
    ['update', '기존 대상자 업데이트'], ['totals', '일계 대조'],
  ];
  const tabBar = h('div', { class: 'toolbar', role: 'group', 'aria-label': '보고서 작업' });
  let tab = 'export';

  function show(id) {
    tab = id;
    tabBar.replaceChildren(...tabs.map(([key, label]) =>
      h('button', { type: 'button', class: key === tab ? '' : 'secondary', 'aria-pressed': key === tab ? 'true' : 'false', onclick: () => show(key) }, label)));
    panel.replaceChildren(({
      export: exportPanel, templates: templatePanel, import: importPanel, update: updatePanel, totals: totalsPanel,
    })[id]());
  }

  // 1) 결과 조회·내보내기
  function exportPanel() {
    const slot = h('div');
    const result = h('div');
    const select = (name, label, options, all = '전체') =>
      field(label, h('select', { name }, option('', all), options.map((o) => option(o.value ?? o, o.label ?? o))));
    const template = h('select', { name: 'template' }, info.exports.map((e) => option(e.id, e.label)));
    const search = h('input', { type: 'search', name: 'search', maxlength: '100', placeholder: '이름·식별번호·인도자·담당자·장소·비고', 'aria-label': '통합 검색: 이름·식별번호·인도자·담당자·찾기 장소·비고' });
    const from = h('input', { type: 'date', name: 'from' });
    const to = h('input', { type: 'date', name: 'to' });
    const basis = h('select', { name: 'basis' }, option('registered', '등록일'), option('activity', '활동일'), option('transition', '단계 변경일'));
    const region = select('region', '구역', info.regions);
    const stageOptions = info.stages.map((s) => ({ value: s.id, label: s.inactive ? `${s.label} (사용 안 함)` : s.label }));
    const stage = select('stage', '단계', stageOptions);
    const klass = select('className', '반', info.classes);
    const employment = select('employment', '직장인 구분', info.employments);

    // 상세 조건: 서버(/api/reports/summary·/export)가 이미 받는 키 그대로 보낸다. 목록은 /info가 권한 구역 안에서 만든 ID·이름뿐이다.
    const opt = info.filters ?? {};
    const placeList = h('datalist', { id: 'report-place-options' }, (opt.places ?? []).map((p) => option(p, p)));
    const place = field('활동 장소 (일부만 입력 가능)', h('input', { type: 'text', name: 'place', maxlength: '200', list: 'report-place-options', placeholder: '장소 이름 일부' }));
    const minutes = (name, label) => field(label, h('input', { type: 'number', name, min: '0', max: '1439', step: '1', inputmode: 'numeric' }));
    const detailFields = [
      place,
      select('classification2', '분류2', opt.classification2 ?? []),
      select('status', '진행 상태', opt.statuses ?? []),
      select('timeBand', '활동 시간대', opt.timeBands ?? []),
      minutes('minMinutes', '최소 활동분'),
      minutes('maxMinutes', '최대 활동분'),
      select('transitionFrom', '이동 전 단계', stageOptions),
      select('transitionTo', '이동 후 단계', stageOptions),
      select('introducerId', '인도자', opt.introducers ?? []),
      select('worker', '담당자', opt.workers ?? []),
      select('orgUnitId', '인도자 소속', opt.orgUnits ?? []),
    ];
    const detailControls = detailFields.map((f) => f.querySelector('input, select'));
    const detailCount = h('span', { class: 'note' });
    const syncDetailCount = () => {
      const n = detailControls.filter((c) => c.value !== '').length;
      detailCount.textContent = n ? ` · ${n}개 적용 중` : '';
    };
    for (const c of detailControls) c.addEventListener('input', syncDetailCount);
    for (const c of detailControls) c.addEventListener('change', syncDetailCount);
    const resetDetails = h('button', { type: 'button', class: 'secondary', onclick: () => {
      for (const c of detailControls) c.value = '';
      syncDetailCount();
    } }, '상세 조건 초기화');
    const details = h('details', { class: 'wide report-details' },
      h('summary', null, '상세 조건', detailCount),
      h('p', { class: 'note' }, '장소·시간대·활동분 조건은 해당 활동이 있는 대상자만 남깁니다. 같은 조건이 조회 요약과 엑셀 내보내기에 함께 적용됩니다.'),
      h('div', { class: 'form-grid' }, detailFields),
      h('div', { class: 'buttons' }, resetDetails),
      placeList);

    // 사용자 지정 상세: 열을 고르고 순서를 옮긴다. 서버는 보낸 순서 그대로 엑셀 열을 만든다.
    const columns = info.columns.map((c) => ({ key: c.key, label: c.label, checked: !DEFAULT_OFF_COLUMNS.includes(c.key) }));
    const columnList = h('ol', { class: 'column-order' });
    const columnNote = h('p', { class: 'note', role: 'status' });
    function renderColumns(focus) {
      columnList.replaceChildren(...columns.map((c, i) => {
        const move = (delta, dir) => () => {
          const target = i + delta;
          [columns[i], columns[target]] = [columns[target], columns[i]];
          columnNote.textContent = `${c.label} 열을 ${target + 1}번째로 옮겼습니다.`;
          renderColumns(`${c.key}:${dir}`);
        };
        return h('li', { class: 'toolbar' },
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: c.checked, onchange: (e) => { c.checked = e.target.checked; } }), `${i + 1}. ${c.label}`),
          h('button', { type: 'button', class: 'secondary', 'data-move': `${c.key}:up`, 'aria-label': `${c.label} 열을 앞으로 이동`, disabled: i === 0, onclick: move(-1, 'up') }, '앞으로'),
          h('button', { type: 'button', class: 'secondary', 'data-move': `${c.key}:down`, 'aria-label': `${c.label} 열을 뒤로 이동`, disabled: i === columns.length - 1, onclick: move(1, 'down') }, '뒤로'));
      }));
      if (focus) {
        const [key, dir] = focus.split(':');
        const wanted = columnList.querySelector(`[data-move="${key}:${dir}"]:not(:disabled)`) ?? columnList.querySelector(`[data-move="${key}:${dir === 'up' ? 'down' : 'up'}"]:not(:disabled)`);
        wanted?.focus();
      }
    }
    renderColumns();
    const columnSet = h('fieldset', { class: 'wide', hidden: true },
      h('legend', null, '사용자 지정 상세 · 출력할 열과 순서'),
      h('p', { class: 'note' }, '체크한 열만 위에서 아래로 보이는 순서대로 엑셀의 왼쪽부터 출력합니다.'),
      columnList, columnNote);
    template.addEventListener('change', () => { columnSet.hidden = template.value !== 'custom'; });

    const query = () => {
      const qs = new URLSearchParams();
      const add = (k, v) => { if (v) qs.set(k, v); };
      add('search', search.value.trim());
      add('from', from.value);
      add('to', to.value);
      add('basis', basis.value);
      for (const node of [region, stage, klass, employment]) {
        const s = node.querySelector('select');
        add(s.name, s.value);
      }
      for (const c of detailControls) add(c.name, c.value.trim());
      const min = qs.get('minMinutes');
      const max = qs.get('maxMinutes');
      for (const v of [min, max]) {
        if (v != null && !(Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 1439)) throw new Error('활동분은 0~1439 사이 정수로 입력해 주세요.');
      }
      if (min != null && max != null && Number(min) > Number(max)) throw new Error('최소 활동분은 최대 활동분보다 클 수 없습니다.');
      return qs;
    };

    const summaryButton = h('button', { type: 'button' }, '조회 요약');
    summaryButton.addEventListener('click', runBusy(summaryButton, slot, async () => {
      const s = await getJson(`/api/reports/summary?${query()}`);
      result.replaceChildren(
        h('h2', null, '조회 요약'),
        countCards({ 대상자: s.people, 활동: s.activities, '활동 시간(분)': s.minutes, 활동자: s.workers, '단계 변경': s.transitionCount }),
        h('div', { class: 'form-grid' },
          h('section', { class: 'card' }, h('h3', null, '단계별'), dataTable('단계별', ['단계', '대상자'], s.stages.map((x) => [x.inactive ? `${x.label} (사용 안 함)` : x.label, String(x.value)]), s.stages.length)),
          h('section', { class: 'card' }, h('h3', null, '구역별'), dataTable('구역별', ['구역', '대상자'], s.regions.map((x) => [x.label, String(x.value)]), s.regions.length)),
          h('section', { class: 'card' }, h('h3', null, '반별'), dataTable('반별', ['반', '대상자'], s.classes.map((x) => [x.label, String(x.value)]), s.classes.length)),
          h('section', { class: 'card' }, h('h3', null, '시간대별 활동'), dataTable('시간대별', ['시간대', '활동'], s.bands.map((x) => [x.label, String(x.value)]), s.bands.length))));
    }));

    const exportButton = h('button', { type: 'button', class: 'secondary' }, '엑셀 내보내기');
    exportButton.addEventListener('click', runBusy(exportButton, slot, async () => {
      const qs = query();
      qs.set('template', template.value);
      if (template.value === 'custom') {
        const chosen = columns.filter((c) => c.checked).map((c) => c.key);
        if (!chosen.length) throw new Error('출력할 열을 하나 이상 선택해 주세요.');
        qs.set('columns', chosen.join(','));
      }
      await downloadFile(`/api/reports/export?${qs}`, 'smoa-report.xlsx');
      toast('엑셀 파일을 내려받았습니다.');
    }));

    if (!info.regions.length) return h('div', { class: 'card empty' }, '조회할 수 있는 구역이 없습니다. 관리자에게 구역 권한을 요청해 주세요.');
    return h('div', null,
      h('div', { class: 'card' },
        h('p', { class: 'note' }, `조회 구역: ${info.regions.join(', ')} · 접근 권한이 있는 구역의 자료만 집계·출력합니다. 연락처는 끝 네 자리만 나옵니다. 일반 엑셀 파일은 암호화되지 않으니 보관에 주의해 주세요.`),
        h('div', { class: 'form-grid report-filters' },
          field('통합 검색', search, 'wide'),
          field('출력 양식', template), field('기간 기준', basis), field('시작일', from), field('종료일', to),
          region, stage, klass, employment, details, columnSet),
        h('div', { class: 'buttons' }, summaryButton, perm.export ? exportButton : null),
        slot),
      result);
  }

  // 2) 양식: 데이터 종류별로 반영 위치와 시트별 안내를 보여 주고 내려받는다.
  function templatePanel() {
    const slot = h('div');
    return h('div', null,
      h('p', { class: 'note' }, '입력할 데이터 종류에 맞는 양식을 고르세요. 시트 이름과 열 이름은 바꾸지 마세요. 연락처 열은 이 웹에서 읽지 않습니다.'),
      info.templates.map((t) => {
        const button = h('button', { type: 'button', class: 'secondary' }, `${t.label} 내려받기`);
        button.addEventListener('click', runBusy(button, slot, async () => {
          await downloadFile(`/api/reports/templates/${encodeURIComponent(t.id)}`, `smoa-template-${t.id}.xlsx`);
          toast('양식을 내려받았습니다.');
        }));
        return h('section', { class: 'card' },
          h('h2', null, t.label), h('p', { class: 'note' }, t.description),
          t.sheets?.length ? h('details', null,
            h('summary', null, `시트 ${t.sheets.length}개 · 반영 위치와 작성 안내`),
            dataTable(`${t.label} 시트 안내`, ['시트', '반영 위치', '열', '작성 안내'],
              t.sheets.map((s) => [s.name, s.to, s.columns.length ? s.columns.join(' · ') : '(열 없음)', s.note]), t.sheets.length)) : null,
          h('div', { class: 'buttons' }, button));
      }), slot);
  }

  // 3·4) 가져오기: 일반 입력 양식과 기존 대상자 업데이트 양식은 미리보기 경로만 다르고 같은 반영 경로를 쓴다.
  function renderPreview(result, data) {
    const applySlot = h('div');
    const applyButton = h('button', { type: 'button' }, '미리보기대로 반영');
    applyButton.addEventListener('click', runBusy(applyButton, applySlot, async () => {
      if (!window.confirm('미리보기 내용을 자료에 반영합니다. 계속할까요?')) return;
      await sendJson('POST', '/api/reports/apply', { importId: data.importId });
      applyButton.hidden = true;
      applySlot.replaceChildren(statusLine('반영했습니다. 같은 파일을 다시 반영하면 중복은 건너뜁니다.', 'ok'));
      toast('반영했습니다.');
    }));
    const update = data.mode === 'person-update';
    setChildren(result,
      h('h2', null, update ? '기존 대상자 업데이트 미리보기' : '가져오기 미리보기'),
      h('p', { class: 'note' }, `이 미리보기는 ${new Date(data.expiresAt).toLocaleTimeString('ko-KR')}까지 유효합니다.`),
      countCards(data.counts),
      messageList('안내', data.notes, 'note'),
      messageList(`오류 — 고치기 전에는 반영할 수 없습니다${data.totalErrors > data.errors.length ? ` (전체 ${data.totalErrors}건 중 일부)` : ''}`, data.errors, 'error'),
      messageList('확인이 필요한 항목', data.warnings, 'note'),
      h('section', { class: 'card' }, h('h3', null, `변경 내용 (${data.totalChanges}건)`),
        dataTable('변경 내용', ['처리', '대상', '바뀌는 항목'], data.changes.map((c) => [c.action, c.target, c.summary || '—']), data.totalChanges)),
      data.totalDuplicates ? h('p', { class: 'note' }, `기존 기록과 같아 건너뛰는 항목이 ${data.totalDuplicates}건 있습니다.`) : null,
      data.canApply ? h('div', { class: 'toolbar' }, applyButton, applySlot) : statusLine('반영할 수 있는 변경이 없거나 오류가 있습니다.'));
  }

  function uploadPanel({ endpoint, intro, noPermission, templateId }) {
    if (!perm.write) return h('div', { class: 'card empty' }, noPermission);
    const slot = h('div');
    const result = h('div');
    const file = h('input', { type: 'file', accept: '.xlsx' });
    const submit = h('button', { type: 'button' }, '미리보기');
    submit.addEventListener('click', runBusy(submit, slot, async () => {
      renderPreview(result, await uploadXlsx(endpoint, file.files[0]));
    }));
    const templateButton = h('button', { type: 'button', class: 'secondary' }, '이 가져오기의 양식 내려받기');
    templateButton.addEventListener('click', runBusy(templateButton, slot, async () => {
      await downloadFile(`/api/reports/templates/${templateId}`, `smoa-template-${templateId}.xlsx`);
      toast('양식을 내려받았습니다.');
    }));
    return h('div', null,
      h('div', { class: 'card' },
        h('p', { class: 'note' }, intro),
        field('엑셀 파일', file),
        h('div', { class: 'buttons' }, submit, templateButton), slot),
      result);
  }

  const importPanel = () => uploadPanel({
    endpoint: '/api/reports/import-preview',
    templateId: 'input',
    noPermission: '엑셀 자료를 가져오려면 이 화면의 쓰기 권한이 필요합니다.',
    intro: `자료 입력 양식(.xlsx)이나 활동기록·찾기건 개별 양식을 올리면 먼저 미리보기를 만들고, 확인 뒤에만 반영합니다. 접근 권한이 없는 구역의 행은 제외되며, 휴대폰 번호 열은 읽지 않습니다. ${info.blockedSheets.join('·')} 시트는 관리 화면에서 처리합니다.`,
  });

  const updatePanel = () => uploadPanel({
    endpoint: '/api/reports/target-update-preview',
    templateId: 'person-update',
    noPermission: '기존 대상자를 업데이트하려면 이 화면의 쓰기 권한이 필요합니다.',
    intro: '기존 대상자 업데이트 양식(.xlsx)을 올리면 이미 등록된 대상자만 찾아 단계·교사·탈락일·사유·단계별 최초 도달일을 고치는 미리보기를 만듭니다. 새 대상자는 만들지 않으며, 일치하지 않거나 여러 명과 일치하는 행은 확인 항목으로 알려 줍니다. 담당 구역 밖 대상자는 찾을 수 없고, 휴대폰 번호 열은 읽지 않습니다.',
  });

  // 5) 입력 일계와 상세 등록 대조
  function totalsPanel() {
    const slot = h('div');
    const result = h('div');
    const from = h('input', { type: 'date', name: 'from' });
    const to = h('input', { type: 'date', name: 'to' });
    const region = field('구역', h('select', { name: 'region' }, option('', '전체 구역'), info.regions.map((r) => option(r, r))));
    const submit = h('button', { type: 'button' }, '조회');
    submit.addEventListener('click', runBusy(submit, slot, async () => {
      if (from.value && to.value && from.value > to.value) throw new Error('시작일은 종료일보다 늦을 수 없습니다.');
      const qs = new URLSearchParams();
      if (from.value) qs.set('from', from.value);
      if (to.value) qs.set('to', to.value);
      const selected = region.querySelector('select').value;
      if (selected) qs.set('region', selected);
      const d = await getJson(`/api/reports/daily-totals?${qs}`);
      setChildren(result,
        h('h2', null, '입력 일계 대조'),
        dataTable('입력 일계 대조', ['날짜', '구역', '입력 찾기', '상세 찾기', '차이', '단계 향상', '탈락'],
          d.items.map((r) => [r.date, r.region, String(r.entered), String(r.detailed), String(r.difference), String(r.advanced), String(r.dropped)]), d.items.length),
        d.total ? h('p', { class: 'note' }, `${d.total > d.items.length ? `전체 ${d.total}건 중 ` : ''}최근 일자부터 최대 ${d.limit}건을 표시합니다. 차이가 있어도 개인 기록을 자동으로 만들지 않습니다.`) : null);
    }));
    if (!info.regions.length) return h('div', { class: 'card empty' }, '조회할 수 있는 구역이 없습니다. 관리자에게 구역 권한을 요청해 주세요.');
    return h('div', null,
      h('div', { class: 'card' },
        h('p', { class: 'note' }, '구역일계 시트로 입력한 보고 숫자(입력 찾기)와 개인 상세로 등록된 대상자 수(상세 찾기)를 같은 날짜·구역끼리 견줍니다. 접근 권한이 있는 구역만 나옵니다.'),
        h('div', { class: 'form-grid' }, field('시작일', from), field('종료일', to), region),
        h('div', { class: 'buttons' }, submit), slot),
      result);
  }

  box.append(h('h1', null, '보고서'), tabBar, panel);
  show('export');
}

export const reportsViews = { reports };
