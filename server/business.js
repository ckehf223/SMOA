import { scopeFor } from './permissions.js';
import { HttpError } from './security.js';
import { dashboardOverview } from './dashboard.js';
import { buildWorkbook, createPerson, dashboard, filterPeople, seoulDate, toPublic, updatePerson, validatePerson } from './people.js';
import { personDetailRoutes } from './person-details.js';

const PAGE_SIZE = 20;

/** 업무 화면 API. 접근 여부는 app.js의 중앙 가드(screen·action)가 먼저 판단하고, 자료는 구역 범위로 다시 제한한다. */
export function businessRoutes(store) {
  const scopeOf = (ctx) => scopeFor(store, ctx.user);
  const findInScope = (ctx) => {
    const p = store.people.find((x) => x.id === ctx.params[0]);
    if (!p || !scopeOf(ctx).has(p.districtId)) throw new HttpError(404, '대상자를 찾을 수 없습니다.');
    return p;
  };

  return [
    { method: 'GET', path: '/api/dashboard', screen: 'dashboard', action: 'read', handler: (ctx) => dashboard(store, scopeOf(ctx)) },
    // 4.0.41 지역 대시보드의 집계(읽기 전용). 구역 범위·기간 검증은 server/dashboard.js에서 한다.
    { method: 'GET', path: '/api/dashboard/overview', screen: 'dashboard', action: 'read', handler: (ctx) => dashboardOverview(store, ctx) },
    {
      method: 'GET',
      path: '/api/people',
      screen: 'people',
      action: 'read',
      handler: (ctx) => {
        const rows = filterPeople(store, scopeOf(ctx), ctx.query);
        const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
        const page = Math.min(pages, Math.max(1, Number.parseInt(ctx.query.get('page'), 10) || 1));
        return { total: rows.length, page, pages, pageSize: PAGE_SIZE, items: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(toPublic) };
      },
    },
    {
      method: 'GET',
      path: '/api/people/export',
      screen: 'people',
      action: 'export',
      handler: async (ctx) => {
        const rows = filterPeople(store, scopeOf(ctx), ctx.query);
        const stamp = seoulDate(store.now()).replaceAll('-', '');
        return {
          raw: true,
          status: 200,
          headers: {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="smoa-people-${stamp}.xlsx"`,
          },
          body: await buildWorkbook(store, rows),
        };
      },
    },
    {
      method: 'POST',
      path: '/api/people',
      screen: 'people',
      action: 'write',
      handler: (ctx) => ({ person: toPublic(createPerson(store, ctx.user, validatePerson(ctx.body, store, scopeOf(ctx)))) }),
    },
    {
      method: 'PUT',
      path: '/api/people/:id',
      screen: 'people',
      action: 'write',
      handler: (ctx) => {
        const person = findInScope(ctx);
        return { person: toPublic(updatePerson(store, ctx.user, person, validatePerson(ctx.body, store, scopeOf(ctx), person))) };
      },
    },
    // 대상자 상세·탈락/복귀·삭제·편집용 선택 목록(server/person-details.js)
    ...personDetailRoutes(store),
  ];
}
