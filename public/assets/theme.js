/**
 * 화면 모드: 라이트/다크, 색상 테마, 밀도. 기존 SMOA 데스크톱 앱(src/ui/theme.js)과 같은 저장 키와 선택지를 쓴다.
 * <head>에서 일반 스크립트로 먼저 읽혀 첫 화면부터 저장된 모드가 적용된다(깜빡임 없음).
 * 저장소를 쓸 수 없거나 값이 올바르지 않으면 기본값(라이트 / 청량한 블루 / 표준 보기)으로 동작한다.
 * 조절 장치는 [data-display-controls] 자리에 한 곳에서 만들어 로그인·업무·관리 화면이 똑같이 쓴다.
 */
(() => {
  const PREFERENCES = {
    design: {
      label: '색상 테마', name: '화면 색상 테마', key: 'smoa-design-v2', fallback: 'navy',
      choices: [['navy', '청량한 블루'], ['sage', '차분한 그린'], ['sand', '따뜻한 샌드'], ['journal', '데이터 저널']],
    },
    density: {
      label: '밀도', name: '화면 밀도', key: 'smoa-density', fallback: 'balanced',
      choices: [['balanced', '표준 보기'], ['spacious', '여유 보기'], ['compact', '촘촘 보기']],
    },
  };
  const THEME_KEY = 'smoa-theme';
  const root = document.documentElement;

  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* 저장소를 못 쓰면 이번 방문에만 적용 */ } };

  function setPreference(name, value, save) {
    const { choices, fallback, key } = PREFERENCES[name];
    const mode = choices.some(([v]) => v === value) ? value : fallback;
    root.dataset[name] = mode;
    for (const select of document.querySelectorAll(`select[data-display-preference="${name}"]`)) select.value = mode;
    if (save) write(key, mode);
  }

  function setTheme(value, save) {
    const mode = value === 'dark' ? 'dark' : 'light';
    root.dataset.theme = mode;
    for (const b of document.querySelectorAll('[data-action="theme-toggle"]')) {
      b.textContent = mode === 'dark' ? '☀ 라이트' : '☾ 다크';
      b.setAttribute('aria-label', mode === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환');
    }
    if (save) write(THEME_KEY, mode);
  }

  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    node.append(...kids);
    return node;
  };

  function renderControls() {
    for (const box of document.querySelectorAll('[data-display-controls]')) {
      if (box.childElementCount) continue;
      for (const [name, p] of Object.entries(PREFERENCES)) {
        const id = `display-${name}`;
        const select = el('select', { id, 'data-display-preference': name, 'aria-label': p.name },
          ...p.choices.map(([v, text]) => el('option', { value: v }, text)));
        box.append(el('label', { class: 'display-preference', for: id }, el('span', {}, p.label), select));
      }
      box.append(el('button', { type: 'button', class: 'secondary small', 'data-action': 'theme-toggle' }));
    }
    for (const name of Object.keys(PREFERENCES)) setPreference(name, root.dataset[name], false);
    setTheme(root.dataset.theme, false);
  }

  // 먼저 저장된 값을 적용한다. 저장은 사용자가 바꿀 때만 한다.
  for (const [name, p] of Object.entries(PREFERENCES)) setPreference(name, read(p.key), false);
  setTheme(read(THEME_KEY), false);

  document.addEventListener('DOMContentLoaded', renderControls);
  document.addEventListener('change', (e) => {
    const name = e.target?.dataset?.displayPreference;
    if (name && Object.hasOwn(PREFERENCES, name)) setPreference(name, e.target.value, true);
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-action="theme-toggle"]')) setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true);
  });
  // 다른 탭에서 바꾼 모드도 바로 따라간다.
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY) setTheme(e.newValue, false);
    for (const [name, p] of Object.entries(PREFERENCES)) if (e.key === p.key) setPreference(name, e.newValue, false);
  });
})();
