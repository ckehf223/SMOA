/**
 * 선택 상자 옆 검색 입력. 이미 서버에서 받은 옵션만 브라우저에서 걸러 보인다(추가 요청·추가 자료 없음).
 * - 검색어는 공백으로 나눈 모든 낱말이 옵션의 검색 문자열(data-search, 없으면 표시 글자)에 들어 있으면 일치한다.
 *   대소문자·전각/반각·공백 차이는 무시한다.
 * - 빈 값 옵션, data-keep 옵션(예: '기존 활동자 유지')과 현재 선택된 옵션은 항상 남겨 두므로, 검색만으로 기존 선택값이 지워지지 않는다.
 * - 옵션 노드를 그대로 다시 붙이므로 옵션의 글자·aria 속성은 바뀌지 않는다.
 */

const norm = (v) => String(v ?? '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();

/** 옵션에 붙일 검색 문자열. 응답에 실제로 있는 값만 넘긴다. */
export const searchKey = (...values) => values.filter((v) => v != null && v !== '').join(' ');

export function optionSearch(select, { label = '검색', placeholder = '이름 검색' } = {}) {
  let all = [...select.options];
  const input = document.createElement('input');
  input.type = 'search';
  input.autocomplete = 'off';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  // 양식 제출 값에 섞이지 않도록 name을 두지 않는다.
  const count = document.createElement('small');
  count.className = 'note';
  count.setAttribute('aria-live', 'polite');

  function apply() {
    const tokens = input.value.split(/\s+/).map(norm).filter(Boolean);
    const value = select.value;
    const keep = all.filter((o) => !o.value || o.value === value || 'keep' in o.dataset
      || tokens.every((t) => norm(o.dataset.search || o.textContent).includes(t)));
    select.replaceChildren(...keep);
    select.value = value;
    const counted = (o) => o.value && !('keep' in o.dataset);
    const total = all.filter(counted).length;
    const shown = keep.filter(counted).length;
    count.textContent = tokens.length ? `${total}개 중 ${shown}개` : '';
  }
  input.addEventListener('input', apply);
  // 검색창에서 Enter를 눌러도 대화상자 양식이 제출되지 않게 한다.
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) e.preventDefault(); });

  const box = document.createElement('span');
  box.className = 'option-search';
  box.append(input, count);

  return {
    element: box,
    input,
    /** 호출하는 쪽이 옵션을 새로 채운 뒤 부른다. 검색어를 비우고 새 옵션 전체를 기준으로 삼는다. */
    reset() {
      all = [...select.options];
      input.value = '';
      count.textContent = '';
    },
  };
}
