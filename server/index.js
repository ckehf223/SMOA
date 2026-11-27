import { createApp } from './app.js';

if (!process.argv.includes('--memory')) {
  console.error('로컬 메모리 모드(--memory)를 명시해야 시작합니다. 예: npm run dev');
  process.exit(1);
}

const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.slice(7)) : 3000;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('--port 값을 확인해 주세요.');
  process.exit(1);
}

const app = await createApp();
const actual = await app.listen(port);
console.log(`SMOA 로컬 메모리 모드: http://127.0.0.1:${actual}  (종료하면 모든 자료가 사라집니다)`);
