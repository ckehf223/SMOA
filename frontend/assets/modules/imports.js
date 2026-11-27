import { clear, errorMessage, field, h, notice, select, table } from '../js/ui.js';
import { parse } from '/assets/daily/daily-area-report.js';

const activityLabels = ['적극적 활동자', '전도비 후원자', '소극적 활동자', '비활동자'];
const compact = (value) => String(value || '').normalize('NFC').replace(/\s/g, '');
const districtName = (label) => {
  const name = compact(label);
  const digits = /^(\d+)(?:구역)?$/.exec(name);
  return digits ? String(Number(digits[1])) : name;
};
const mask = (value) => typeof value !== 'string' ? value :
  value.replace(/(?<!\d)(?:\+82[- ]?10|01[016789])[- ]?\d{3,4}[- ]?\d{4}(?!\d)/gu,
    (number) => '끝 네 자리 ' + number.replace(/\D/g, '').slice(-4));

export async function mount(ctx) {
  if (ctx.programId === 'reports') return templates(ctx);
  return daily(ctx);
}

async function templates(ctx) {
  const entries = await ctx.api.get('/api/programs/reports/templates');
  const list = h('ul');
  const status = h('div', { role: 'status' });
  entries.forEach(({ id, name }) => list.append(h('li', {}, name, ' ',
    ctx.permissions.export ? h('button', { type: 'button', class: 'btn small', text: '엑셀 양식 받기',
      onclick: async () => {
        try {
          await ctx.api.download(`/api/programs/reports/export/${id}.xlsx`, `${name}.xlsx`);
        } catch (error) {
          clear(status).append(notice('error', errorMessage(error)));
        }
      },
    }) : null)));
  ctx.container.append(h('section', { class: 'panel' }, h('h3', { text: '엑셀 양식' }), list, status));
}

async function daily(ctx) {
  const districts = await ctx.api.get('/api/programs/daily/options');
  const year = h('input', { type: 'number', min: 1900, max: 9999,
    value: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 4), required: true });
  const text = h('textarea', { maxlength: 200000, rows: 8, required: true, placeholder: '구역명과 보고일이 포함된 일보를 붙여넣으세요.' });
  const result = h('div');
  const state = h('div', { role: 'status' });
  const form = h('form', { class: 'panel', onsubmit: (event) => {
    event.preventDefault();
    clear(result);
    clear(state);
    try {
      render(parse(text.value, Number(year.value)));
    } catch (error) {
      state.append(notice('error', mask(errorMessage(error))));
    }
  } }, field('기준 연도', year), field('구역 일보', text),
  h('button', { type: 'submit', class: 'btn primary', text: '변환 미리보기' }));
  ctx.container.append(form, state, result);

  function render({ reports, warnings }) {
    const selections = [];
    const options = districts.map((d) => [JSON.stringify([d.regionCode, d.districtCode]), [d.regionName, d.districtName].filter(Boolean).join(' / ')]);
    const buttons = h('div', { class: 'row' });
    if (warnings.length) result.append(h('details', { class: 'panel' },
      h('summary', { text: '확인할 항목 ' + warnings.length + '건' }),
      h('ul', {}, warnings.slice(0, 100).map((line) => h('li', { text: mask(line) })))));
    if (ctx.permissions.export && districts.length) {
      const download = h('button', { type: 'button', class: 'btn primary', text: '변환 결과 엑셀 받기',
        onclick: async () => {
          download.disabled = true;
          clear(state);
          try {
            const output = { activities: [], people: [] };
            for (const { report, district } of selections) {
              if (!district.value) throw new Error('변환한 일보의 구역을 지정해 주세요.');
              const [regionCode, districtCode] = JSON.parse(district.value);
              const common = { regionCode, districtCode, reportDate: report.date };
              for (const a of report.activities) output.activities.push({ ...common, name: mask(a.name), status: a.status });
              for (const p of report.changes) {
                const fields = ['date', 'stage', 'status', 'name', 'classification1', 'classification2', 'method', 'gender',
                  'age', 'residence', 'place', 'time', 'introducer', 'teacher', 'reason'];
                const safe = Object.fromEntries(fields.map((key) => [key, mask(p[key])]));
                if (safe.age === '' || safe.age == null) safe.age = null;
                output.people.push({ ...common, ...safe });
              }
            }
            await ctx.api.download('/api/programs/daily/export/conversion.xlsx', '구역일보-변환.xlsx', output);
          } catch (error) {
            state.append(notice('error', errorMessage(error)));
          } finally {
            download.disabled = false;
          }
        },
      });
      buttons.append(download);
      result.append(h('div', { class: 'panel' }, buttons));
    }
    for (const report of reports) {
      const matching = districts.filter((item) => districtName(item.districtName) === districtName(report.district));
      const defaultDistrict = matching.length === 1 ? JSON.stringify([matching[0].regionCode, matching[0].districtCode]) : '';
      const district = select([['', '구역 선택'], ...options], defaultDistrict);
      selections.push({ report, district });
      const activity = table([
        { key: 'name', label: '이름', render: (item) => mask(item.name) },
        { label: '활동 여부', render: (item) => activityLabels[item.status - 1] || '확인 필요' },
      ], report.activities.slice(0, 200));
      const people = table([
        { key: 'date', label: '날짜' }, { key: 'stage', label: '단계' }, { key: 'status', label: '구분' },
        { label: '대상자', render: (item) => mask(item.name) }, { label: '인도자', render: (item) => mask(item.introducer) },
        { label: '상담사', render: (item) => mask(item.teacher) }, { label: '탈락사유', render: (item) => mask(item.reason) },
      ], report.changes.slice(0, 200));
      result.append(h('section', { class: 'panel' },
        h('h3', { text: [mask(report.district), report.date].join(' · ') }),
        ctx.permissions.export ? field('엑셀에 표시할 구역', district) : null,
        h('details', { open: true }, h('summary', { text: '활동자 ' + report.activities.length + '명' }), activity),
        h('details', { open: true }, h('summary', { text: '대상자 ' + report.changes.length + '건' }), people),
        report.activities.length > 200 || report.changes.length > 200
          ? h('p', { class: 'muted', text: '미리보기는 표마다 200행까지 표시합니다. 엑셀에는 전체 행을 넣습니다.' }) : null));
    }
  }
}
