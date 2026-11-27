import { api } from './common.js';

const form = document.getElementById('form');
const status = document.getElementById('status');

fetch('/api/public/info').then((r) => r.json()).then((info) => {
  document.getElementById('brand').textContent = info.siteName;
  document.title = `${info.siteName} 로그인`;
}).catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  status.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const data = new FormData(form);
    const res = await api('POST', '/api/login', { username: data.get('username'), password: data.get('password') });
    location.href = (await res.json()).home;
  } catch (err) {
    status.textContent = err.message;
    form.password.value = '';
    form.password.focus();
  } finally {
    button.disabled = false;
  }
});
