// 공통 DOM 도우미. 사용자 입력·서버 값은 항상 textContent 로 넣는다(innerHTML 사용 금지).
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'selected') node[key] = Boolean(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

let toastTimer = null;
export function toast(message, kind = 'info') {
  const box = document.getElementById('toast');
  if (!box) return;
  box.textContent = message;
  box.className = `toast ${kind}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 5000);
}

/** API 오류를 사용자 문구로 바꾼다. 구현 세부는 서버가 이미 제거한 메시지만 쓴다. */
export function errorMessage(error) {
  if (!error) return '알 수 없는 오류';
  if (error.status === 401) return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
  if (error.status === 403) return '이 기능에 대한 권한이 없습니다.';
  if (error.status === 501) return '데이터 연결 준비 중입니다.';
  return error.message || '요청을 처리하지 못했습니다.';
}

export function notice(kind, message) {
  return h('div', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status', text: message });
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), control,
    hint ? h('small', { class: 'muted', text: hint }) : null);
}

export function select(options, value, attrs = {}) {
  const el = h('select', attrs);
  for (const opt of options) {
    const [val, text] = Array.isArray(opt) ? opt : [opt, opt];
    el.append(h('option', { value: val, text, selected: String(val) === String(value ?? '') }));
  }
  return el;
}

export function table(columns, rows, emptyText = '표시할 자료가 없습니다.') {
  const head = h('tr', {}, columns.map((c) => h('th', { text: c.label })));
  const body = h('tbody');
  if (!rows.length) {
    body.append(h('tr', {}, h('td', { colspan: columns.length, class: 'muted', text: emptyText })));
  }
  for (const row of rows) {
    body.append(h('tr', {}, columns.map((c) => {
      const content = c.render ? c.render(row) : row[c.key];
      return h('td', { 'data-label': c.label }, content === undefined || content === null ? '' : content);
    })));
  }
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, head), body));
}

export function badge(text, kind = '') {
  return h('span', { class: `badge ${kind}`, text });
}

export function confirmAction(message) {
  return window.confirm(message);
}
