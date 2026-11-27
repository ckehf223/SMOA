import { clear, errorMessage, field, h, notice, select } from '../js/ui.js';

const LIBRARY_SETTINGS = '/api/programs/settings/data/library';
const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

export async function mount(ctx) {
  const panel = h('section', { class: 'panel' });
  clear(ctx.container).append(panel);
  panel.append(notice('info', '자료실 설정을 조회하는 중입니다.'));

  function render(settings) {
    const canWrite = settings.writable && ctx.permissions?.write;
    const weekdays = select(WEEKDAYS.map((label, value) => [value, label]), settings.weekStart,
      { name: 'weekStart', disabled: !canWrite });
    const save = h('button', { type: 'submit', class: 'btn primary', text: '설정 저장' });
    const status = h('div', { role: 'status' });
    const form = h('form', { onsubmit: async (event) => {
      event.preventDefault();
      if (!canWrite || save.disabled) return;
      save.disabled = true;
      weekdays.disabled = true;
      clear(status);
      try {
        const updated = await ctx.api.put(LIBRARY_SETTINGS, { weekStart: Number(weekdays.value), revision: settings.revision });
        render(updated);
        ctx.toast('자료실 설정을 저장했습니다.', 'ok');
      } catch (error) {
        status.append(notice('error', errorMessage(error)));
        save.disabled = false;
        weekdays.disabled = false;
        if (error.status === 409) {
          status.append(h('button', { type: 'button', class: 'btn', text: '다시 조회', onclick: load }));
        }
      }
    } },
    field('주 시작 요일', weekdays, '콜링의 금주 조회에 적용합니다.'),
    canWrite ? h('div', { class: 'actions' }, save) : null, status);
    clear(panel).append(h('h3', { text: '자료실 설정' }), h('p', { text: settings.libraryName }), form);
  }

  async function load() {
    try {
      render(await ctx.api.get(LIBRARY_SETTINGS));
    } catch (error) {
      clear(panel).append(notice('error', errorMessage(error)));
    }
  }

  await load();
}
