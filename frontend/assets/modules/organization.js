import { field, h, select } from '../js/ui.js';
import { action, anyText, column, districtKey, districtSelect, editor, editorActions, input, mountData, saveRow, section } from './business-ui.js';

const useName = (row) => row.useInd === 'Y' || row.active ? '사용' : '미사용';
const keyword = (value, placeholder) => field('검색', input('q', value, { type: 'search', placeholder }));

function organization(ctx) {
  const endpoint = '/api/programs/organization/data/members';
  return mountData(ctx, {
    xlsx: 'organization.xlsx',
    fields: (data, values) => [
      field('구역', districtSelect(data.districts, 'scope', districtKey(values))),
      keyword(values.q, '이름, 구성원ID, 반'),
      field('사용 여부', select([['', '전체'], ['Y', '사용'], ['N', '미사용']], values.use, { name: 'use' })),
    ],
    render(data, values, context, refresh) {
      const canWrite = context.permissions?.write;
      const open = (row = {}) => {
        const textField = (label, name, maxlength = 60, required = false) =>
          field(label, input(name, row[name], { maxlength, required }));
        editor(context, row.id ? '구성원 편집' : '구성원 등록', [
          textField('이름', 'name', 60, true), textField('구성원ID', 'code'),
          field('구역', districtSelect(data.districts, 'scope', districtKey(row.id ? row : values), '미소속')),
          textField('반', 'className'), textField('직책', 'title'), textField('직업구분', 'job', 20),
          textField('상태', 'status', 20),
          field('사용 여부', select([['Y', '사용'], ['N', '미사용']], row.useInd || 'Y', { name: 'useInd' })),
        ], (body) => saveRow(context, endpoint, row, body), refresh);
      };
      const members = data.members;
      return [
        canWrite ? h('div', { class: 'actions' }, action('구성원 등록', () => open(), 'primary')) : null,
        section(`구성원 명부 (${members.length}명)`, [
          column('code', '구성원ID'), column('name', '이름'), column('regionName', '지역'), column('districtName', '구역'),
          column('className', '반'), column('title', '직책'), column('job', '직업구분'), column('status', '상태'),
          column('useInd', '사용 여부', useName),
          ...(canWrite ? [column('actions', '관리', (row) =>
            editorActions(context, endpoint, row, open, refresh, '사용 해제'))] : []),
        ], members),
        h('div', { class: 'grid2' },
          section('지역', [column('regionCode', '지역 코드'), column('name', '지역명'), column('active', '사용 여부', useName)], data.regions),
          section('구역', [column('districtCode', '구역 코드'), column('regionName', '지역'), column('districtName', '구역명'),
            column('active', '사용 여부', useName)], data.districts)),
      ];
    },
  });
}

function codes(ctx) {
  return mountData(ctx, {
    clientKeys: ['q', 'group'],
    fields: (data, values) => [
      field('코드 그룹', select([['', '전체 그룹'], ...data.groups.map((row) => [row.code, row.name])], values.group, { name: 'group' })),
      keyword(values.q, '코드, 코드명'),
    ],
    render(data, values) {
      const items = data.items.filter((row) => (!values.group || row.groupCode === values.group)
        && anyText(row, values.q, ['name', 'code', 'groupCode']));
      return [
        section(`공통코드 (${items.length}건)`, [
          column('groupCode', '그룹'), column('code', '코드'), column('name', '코드명'), column('sortOrder', '표시 순서'),
          column('useInd', '사용 여부', useName), column('aliasesJson', '다른 이름', (row) => {
            try { return (JSON.parse(row.aliasesJson || '[]') || []).join(', '); }
            catch { return ''; }
          }),
        ], items),
        section('코드 그룹', [column('code', '그룹 코드'), column('name', '그룹명'), column('useInd', '사용 여부', useName)], data.groups),
      ];
    },
  });
}

export async function mount(ctx) {
  if (ctx.programId === 'organization') return organization(ctx);
  if (ctx.programId === 'codes') return codes(ctx);
  if (ctx.programId === 'settings') return (await import('./settings.js')).mount(ctx);
}
