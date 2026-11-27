import { api, login } from './api.js';

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const submit = document.getElementById('login-submit');
const otp = document.getElementById('otp');
const otpField = document.getElementById('login-otp-field');
let otpPolicyReady = false;

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function setOtpRequired(required) {
  otpField.hidden = !required;
  otp.disabled = !required;
  otp.required = required;
  if (required) {
    document.getElementById('login-intro').textContent = '관리자가 발급한 계정과 인증 앱의 코드로 접속합니다.';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!otpPolicyReady || submit.disabled) return;
  errorBox.hidden = true;
  submit.disabled = true;
  const code = otp.disabled ? undefined : otp.value;
  otp.value = '';
  try {
    const me = await login(form.username.value.trim(), form.password.value, code);
    if (me.devMemory) document.getElementById('login-dev').hidden = false;
    // 이동 위치는 항상 공통 셸(같은 출처)이다. 외부 주소·임의 경로는 받지 않는다.
    window.location.replace('/index.html');
  } catch (error) {
    if (error.status === 429) showError('로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    else if (error.code === 'OTP_NOT_ENROLLED') showError('OTP 등록 키 발급을 관리자에게 요청하세요.');
    else if (error.code === 'OTP_REQUIRED') {
      setOtpRequired(true);
      showError('비밀번호와 인증 앱의 6자리 코드를 입력해 주세요.');
    } else if (error.code === 'OTP_INVALID') {
      showError('인증 앱에서 새 6자리 코드를 확인하고 다시 시도해 주세요.');
    } else if (error.status === 401) showError('로그인 ID 또는 비밀번호가 올바르지 않습니다.');
    else showError('로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  } finally {
    form.password.value = '';
    otp.value = '';
    submit.disabled = false;
  }
});

async function loadOtpPolicy() {
  try {
    const policy = await api.get('/api/auth/otp-policy');
    if (typeof policy?.required !== 'boolean') throw new Error('Invalid OTP policy');
    setOtpRequired(policy.required);
    otpPolicyReady = true;
    submit.disabled = false;
  } catch {
    showError('로그인 설정을 확인할 수 없습니다. 페이지를 새로고침해 주세요.');
  }
}

void loadOtpPolicy();
