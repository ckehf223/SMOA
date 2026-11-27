import { formDialog, getJson, h, nameOf, sendJson, toast } from './common.js';
import { optionSearch, searchKey } from './option-search.js';

/**
 * 대상자 상세·등록·수정·탈락/복귀·삭제 화면. 모든 자료는 서버 API를 거치고,
 * 구역 범위·권한·연락처 끝 네 자리 처리는 서버가 정한다. 화면은 받은 값만 보여 준다.
 */

const dash = (v) => (v === '' || v == null ? '—' : String(v));
const stamp = (local, unknown) => (unknown ? `${local.slice(0, 10)} (시각 미기록)` : local.replace('T', ' '));
const recordedAt = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR');
};
const localNow = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const today = () => localNow().slice(0, 10);
const field = (label, control, cls) => h('label', { class: cls }, label, control);
const withName = (list, current) => list.map((o) => h('option', { value: o.id ?? o, selected: (o.id ?? o) === current }, o.name ?? o));

/**
 * 기본 replaceChildren은 null을 "null" 글자로, 배열을 "[object ...]" 글자로 바꾼다.
 * 배열은 펼치고 비어 있는 자리(null·undefined·false)를 뺀 뒤 넣는다. 0과 빈 문자열은 그대로 둔다.
 */
const replaceContent = (parent, ...kids) => parent.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

function table(caption, head, rows) {
  return h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': caption },
    h('table', null,
      h('thead', null, h('tr', null, head.map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, rows.map((cells) => h('tr', null, cells.map((c) => h('td', null, c)))))));
}

// ---- 사용자 정의 항목 ----------------------------------------------------------

const customName = (id) => `custom:${id}`;

/**
 * 사용자 정의 항목 한 칸. 이름은 `custom:<항목ID>`이고 유형(문자·숫자·날짜·선택·체크)에 맞는 입력 상자를 쓴다.
 * 연락처로 지정된 항목은 이름 없는 읽기 전용 칸(끝 네 자리)이라 저장 요청에 담기지 않는다.
 */
function customControl(def, current) {
  const name = customName(def.id);
  const value = current?.value ?? (def.type === 'boolean' ? false : '');
  if (def.contact) {
    return field(`${def.label} (읽기 전용)`, h('input', { type: 'text', readOnly: true, 'aria-readonly': 'true', value: current?.last4 ? `끝 네 자리 ${current.last4}` : '' }));
  }
  if (def.type === 'boolean') {
    return h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked: value === true }), def.label);
  }
  if (def.type === 'select') {
    const options = def.options.slice();
    // 코드 그룹에서 보관된 기존 값은 수정 때 그대로 둘 수 있다(서버도 기존 값은 허용한다).
    if (def.codeGroup && value !== '' && !options.some((o) => o.value === value)) options.push({ value, label: `${current.display || value} (기존 값)` });
    return field(def.label, h('select', { name },
      h('option', { value: '' }, '(미지정)'),
      options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label))));
  }
  if (def.type === 'number') return field(def.label, h('input', { type: 'number', name, step: 'any', value }));
  if (def.type === 'date') return field(def.label, h('input', { type: 'date', name, value }));
  return field(def.label, h('input', { type: 'text', name, value, maxlength: '2000' }));
}

/** 양식 값 → { 항목ID: 값 }. 숫자는 숫자로, 체크는 true/false로 보낸다. 연락처 항목은 담지 않는다. */
function customPayload(defs, fd) {
  const out = {};
  for (const def of defs) {
    if (def.contact) continue;
    const raw = fd.get(customName(def.id));
    if (def.type === 'boolean') out[def.id] = raw !== null;
    else if (def.type === 'number') out[def.id] = raw === null || raw === '' ? '' : Number(raw);
    else out[def.id] = raw ?? '';
  }
  return out;
}

// ---- 등록·수정 ---------------------------------------------------------------

/** 대상자 등록 대화상자. 저장하면 onSaved(person)를 부른다. */
export function createPersonDialog(me, { onSaved } = {}) {
  return openForm(me, null, { onSaved });
}

/** 대상자 수정 대화상자: 최신 상세를 불러와 값을 채운다. */
export async function editPersonDialog(id, me, { onSaved } = {}) {
  try {
    openForm(me, await getJson(`/api/people/${encodeURIComponent(id)}/detail`), { onSaved });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openForm(me, detail, { onSaved, onStale } = {}) {
  const p = detail?.person ?? null;
  const loadOptions = (districtId) => getJson(`/api/people/options?districtId=${encodeURIComponent(districtId)}`);
  let options;
  try {
    options = await loadOptions(p?.districtId ?? me.districts[0]?.id ?? '');
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  const customDefs = options.customFields ?? [];
  const v = (key, fallback = '') => p?.[key] ?? fallback;
  const text = (name, value, extra) => h('input', { type: 'text', name, value, ...extra });
  const stageChoices = me.stages.filter((s) => s.active || s.id === p?.stageId);

  const districtSelect = h('select', { name: 'districtId', required: true }, withName(me.districts, p?.districtId ?? me.districts[0]?.id));
  const stageSelect = h('select', { name: 'stageId', required: true }, withName(stageChoices, p?.stageId ?? stageChoices[0]?.id));
  const introducerSelect = h('select', { name: 'introducerId' });
  const classNames = options.classNames.slice();
  if (v('className') && !classNames.some((c) => c.value === v('className'))) classNames.push({ value: v('className'), label: `${v('className')} (기존 값)` });
  const applyDate = h('input', { type: 'date', name: 'stageApplyDate', max: today(), disabled: true });
  const applyField = field('단계 적용일 (비우면 오늘)', applyDate);
  applyField.hidden = true;

  // 인도자 찾기: 서버가 돌려준 현재 구역 인도자의 이름·식별번호·반만 브라우저에서 걸러 본다.
  // 검색은 선택값을 바꾸지 않으며, 구역을 바꾸면 그 구역 목록을 다시 받아 검색어를 비운다.
  const introducerSearch = optionSearch(introducerSelect, { label: '인도자 찾기', placeholder: '이름·번호·반' });
  function fillIntroducers(list, selected) {
    const rows = list.slice();
    if (selected && !rows.some((m) => m.id === selected) && p?.introducer) rows.unshift(p.introducer);
    replaceContent(introducerSelect,
      h('option', { value: '' }, '(없음)'),
      rows.map((m) => h('option', { value: m.id, selected: m.id === selected, 'data-search': searchKey(m.name, m.code, m.className, m.className ? `${m.className}반` : '') }, `${m.name}${m.className ? ` · ${m.className}반` : ''}`)));
    introducerSearch.reset();
  }
  fillIntroducers(options.introducers, p?.introducer?.id ?? '');

  districtSelect.addEventListener('change', async () => {
    try {
      const next = await loadOptions(districtSelect.value);
      fillIntroducers(next.introducers, '');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  stageSelect.addEventListener('change', () => {
    const changed = Boolean(p) && stageSelect.value !== p.stageId;
    applyField.hidden = !changed;
    applyDate.disabled = !changed;
  });

  const milestones = options.milestones.length
    ? h('fieldset', { class: 'wide' },
      h('legend', null, '단계별 최초 도달일'),
      h('div', { class: 'form-grid' }, options.milestones.map((m) => {
        const current = p?.milestones.find((x) => x.field === m.field)?.date ?? '';
        return field(m.label, h('input', { type: 'date', name: m.field, value: current, max: today() }));
      })),
      h('small', null, '날짜를 비워 두면 기존 값을 유지합니다.'))
    : null;

  formDialog({
    title: p ? `대상자 수정 · ${p.code}` : '대상자 등록',
    body: h('div', { class: 'form-grid' },
      field('식별번호', h('input', { type: 'text', name: 'code', value: v('code'), disabled: Boolean(p), maxlength: '30', placeholder: '비워 두면 자동 부여' })),
      field('이름 (필수)', text('name', v('name'), { required: true, maxlength: '100' })),
      field('성별', h('select', { name: 'gender' }, withName(me.options.genders, v('gender', '미입력')))),
      field('나이', h('input', { type: 'number', name: 'age', value: v('age'), min: '0', max: '120' })),
      field('구역', districtSelect),
      field('인도자 찾기 (이름·번호·반)', introducerSearch.element),
      field('인도자', introducerSelect, null),
      field('반', h('select', { name: 'className' },
        h('option', { value: '' }, '(미지정)'),
        classNames.map((c) => h('option', { value: c.value, selected: c.value === v('className') }, c.label)))),
      field('담당자', text('worker', v('worker'), { maxlength: '100' })),
      field('단계', stageSelect),
      applyField,
      field('분류1', h('select', { name: 'classification1' }, withName(me.options.classification1, v('classification1')))),
      field('분류2', h('select', { name: 'classification2' }, withName(me.options.classification2, v('classification2')))),
      field(p?.dateUnknown ? '찾은 날짜 (원본 미기록)' : '찾은 날짜', h('input', { type: 'date', name: 'registeredDate', value: p ? v('registeredDate') : today() })),
      field('찾은 시간', h('input', { type: 'time', name: 'registeredTime', value: v('registeredTime') })),
      field('찾기 장소', text('place', v('place'), { maxlength: '200' })),
      field('사용 도구', text('tool', v('tool'), { maxlength: '200' })),
      field('거주지', text('residence', v('residence'), { maxlength: '200' })),
      field('교사', text('teacher', v('teacher'), { maxlength: '100' })),
      field('사유', text('stageReason', v('reason'), { maxlength: '2000' }), 'wide'),
      milestones,
      customDefs.length
        ? h('fieldset', { class: 'wide' },
          h('legend', null, '사용자 항목'),
          h('div', { class: 'form-grid' }, customDefs.map((def) => customControl(def, p?.customFields?.find((c) => c.id === def.id)))))
        : null,
      field('비고', h('textarea', { name: 'notes', maxlength: '2000', value: v('notes') }), 'wide'),
      p?.introducerHidden ? h('p', { class: 'wide' }, '배정 구역 밖 인도자가 연결되어 있습니다. 새로 선택하지 않으면 그대로 유지됩니다.') : null),
    onSubmit: async (fd) => {
      const body = Object.fromEntries([...fd].filter(([key]) => !key.startsWith('custom:')));
      if (customDefs.some((def) => !def.contact)) body.custom = customPayload(customDefs, fd);
      if (p) {
        delete body.code;
        body.revision = p.revision;
      } else {
        // 등록할 때 비워 둔 인도자·반은 서버 기본값(인도자의 반)을 따른다.
        for (const key of ['introducerId', 'className']) if (!body[key]) delete body[key];
      }
      try {
        const res = await sendJson(p ? 'PUT' : 'POST', p ? `/api/people/${encodeURIComponent(p.id)}` : '/api/people', body);
        toast(p ? '수정했습니다.' : '등록했습니다.');
        await onSaved?.(res.person);
      } catch (err) {
        if (err.status === 409) onStale?.();
        throw err;
      }
    },
  });
}

// ---- 상세 --------------------------------------------------------------------

/** 대상자 상세 대화상자. 쓰기 권한이 있을 때만 수정·탈락/복귀·삭제 단추가 나온다. onChange는 자료가 바뀐 뒤 부른다. */
export async function openPersonDetail(id, me, { onChange } = {}) {
  const canWrite = Boolean(me.perms?.people?.write);
  const titleId = `person-title-${id}`;
  const dialog = h('dialog', { 'aria-labelledby': titleId, class: 'person-detail' });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  dialog.append(h('p', { class: 'status' }, '불러오는 중…'));

  const closeButton = () => h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, '닫기');
  let detail = null;

  async function load() {
    try {
      detail = await getJson(`/api/people/${encodeURIComponent(id)}/detail`);
      render();
    } catch (err) {
      dialog.replaceChildren(
        h('p', { class: 'status error', role: 'alert' }, err.message),
        h('div', { class: 'buttons' }, closeButton()));
    }
  }

  const changed = async () => {
    await load();
    await onChange?.();
  };
  const refreshOnStale = () => load();

  function render() {
    const { person: p } = detail;
    const dropped = p.status === 'dropped';
    const introducer = p.introducer
      ? `${p.introducer.name}${p.introducer.className ? ` · ${p.introducer.className}반` : ''}`
      : p.introducerHidden ? '배정 구역 밖 인도자' : '';
    const found = p.dateUnknown ? '원본 미기록' : [p.registeredDate, p.registeredTime].filter(Boolean).join(' ');
    const facts = [
      ['구역', nameOf(me.districts, p.districtId)],
      ['찾은 날짜', found],
      ['분류', `${p.classification1} · ${p.classification2}`],
      ['찾기 장소', p.place],
      ['사용 도구', p.tool],
      ['성별', p.gender],
      ['나이', p.age == null ? '미입력' : `${p.age}세`],
      ['휴대폰 번호', p.phoneLast4 ? `끝 네 자리 ${p.phoneLast4}` : ''],
      ['거주지', p.residence],
      ['인도자', introducer],
      ['반', p.className],
      ['담당자', p.worker],
      ['사유', p.reason],
      ['교사', p.teacher],
      ...p.milestones.map((m) => [m.label, m.date]),
      ...p.customFields.map((c) => [c.label, c.contact ? (c.last4 ? `끝 네 자리 ${c.last4}` : '') : c.display]),
      ['탈락 여부', dropped ? '예' : '아니오'],
      ['탈락일', p.dropoutDate],
    ];

    replaceContent(dialog,
      h('h2', { id: titleId, tabindex: '-1' }, `${p.name} · ${p.code}`),
      h('p', null,
        h('span', { class: 'pill' }, nameOf(me.stages, p.stageId)), ' ',
        h('span', { class: dropped ? 'pill off' : 'pill' }, dropped ? '탈락' : '진행')),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '대상자 기본 정보' },
        h('table', null, h('tbody', null, facts.map(([label, value]) => h('tr', null, h('th', { scope: 'row' }, label), h('td', null, dash(value))))))),
      p.notes ? h('p', null, h('strong', null, '비고 '), p.notes) : null,
      detail.hiddenRecords ? h('p', { class: 'status' }, '배정 구역 밖에서 기록된 활동·이력은 표시하지 않습니다.') : null,

      h('h3', null, '단계의 여정'),
      detail.stageHistory.length
        ? table('단계 이동 이력', ['적용', '단계', '기록', '사유'], detail.stageHistory.map((t) => [
          stamp(t.effectiveLocal, t.timeUnknown),
          `${t.fromName ? `${t.fromName} → ` : ''}${t.toName}`,
          `${recordedAt(t.recordedAt)} · ${t.actor} · ${t.region || '구역 미입력'}`,
          dash(t.reason)]))
        : h('p', { class: 'empty' }, '표시할 단계 이동 이력이 없습니다.'),

      h('h3', null, '활동 기록'),
      detail.activities.length
        ? table('활동 기록', ['날짜', '종류', '장소', '시간', '활동자', '메모'], detail.activities.map((a) => [
          a.date,
          dash(a.kind),
          dash(a.place),
          `${a.start || '—'}–${a.end || '—'} (${a.minutes}분)`,
          dash(a.worker),
          dash(a.notes)]))
        : h('p', { class: 'empty' }, '활동 기록이 없습니다.'),

      detail.lifecycle.length ? h('h3', null, '탈락 · 복귀 이력') : null,
      detail.lifecycle.length
        ? table('탈락·복귀 이력', ['구분', '적용', '사유', '기록'], detail.lifecycle.map((t) => [
          t.to === 'dropped' ? '탈락' : '복귀',
          stamp(t.effectiveLocal, t.timeUnknown),
          dash(t.reason),
          `${recordedAt(t.recordedAt)} · ${t.actor}`]))
        : null,

      canWrite && !detail.delete.allowed ? h('p', { class: 'status' }, detail.delete.reason) : null,
      h('div', { class: 'buttons' },
        canWrite ? h('button', { type: 'button', class: 'danger', onclick: () => lifecycleDialog() }, dropped ? '복귀 처리' : '탈락 처리') : null,
        canWrite ? h('button', { type: 'button', class: 'danger', disabled: !detail.delete.allowed, onclick: () => deleteDialog() }, '삭제') : null,
        canWrite ? h('button', { type: 'button', onclick: () => openForm(me, detail, { onSaved: changed, onStale: refreshOnStale }) }, '정보 수정') : null,
        closeButton()));
    dialog.querySelector('h2').focus();
  }

  function lifecycleDialog() {
    const { person: p } = detail;
    const to = p.status === 'dropped' ? 'active' : 'dropped';
    formDialog({
      title: to === 'dropped' ? `대상자 탈락 처리 · ${p.code}` : `대상자 복귀 처리 · ${p.code}`,
      submitLabel: to === 'dropped' ? '탈락 기록' : '복귀 기록',
      body: h('div', { class: 'form-grid' },
        h('p', { class: 'wide' }, `${p.name} · 기존 대상자·활동·단계 이력은 그대로 남기고 상태 변경을 기록합니다.`),
        field('적용 시각 (필수)', h('input', { type: 'datetime-local', name: 'effectiveLocal', value: localNow(), required: true })),
        field('사유', h('input', { type: 'text', name: 'reason', maxlength: '2000' }))),
      onSubmit: async (fd) => {
        try {
          await sendJson('POST', `/api/people/${encodeURIComponent(p.id)}/lifecycle`, { status: to, effectiveLocal: fd.get('effectiveLocal'), reason: fd.get('reason'), revision: p.revision });
        } catch (err) {
          if (err.status === 409) refreshOnStale();
          throw err;
        }
        toast(to === 'dropped' ? '탈락으로 기록했습니다.' : '복귀로 기록했습니다.');
        await changed();
      },
    });
  }

  function deleteDialog() {
    const { person: p } = detail;
    const calls = detail.links.callingRecords;
    formDialog({
      title: `대상자 삭제 확인 · ${p.code}`,
      submitLabel: '삭제',
      body: h('div', { class: 'form-grid' },
        h('p', { class: 'wide' }, `${p.name}과(와) 연결된 활동 ${detail.activities.length}건을 함께 삭제합니다. 삭제 전 내용은 연락처를 제외하고 변경 이력에 보관합니다.${calls ? ` 콜링 기록 ${calls}건은 삭제하지 않고 콜링 관리에 남깁니다.` : ''}`),
        field(`확인을 위해 식별번호(${p.code})를 입력해 주세요`, h('input', { type: 'text', name: 'confirmCode', required: true, autocomplete: 'off', maxlength: '60' }), 'wide')),
      onSubmit: async (fd) => {
        try {
          await sendJson('DELETE', `/api/people/${encodeURIComponent(p.id)}`, { revision: p.revision, confirmCode: fd.get('confirmCode') });
        } catch (err) {
          if (err.status === 409) refreshOnStale();
          throw err;
        }
        toast('대상자를 삭제했습니다.');
        dialog.close();
        await onChange?.();
      },
    });
  }

  await load();
}
