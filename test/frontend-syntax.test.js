import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 화면 스크립트(public/assets/*.js)에 문법 오류가 없는지 `node --check`로 확인한다. 파일은 실행되지 않는다.
const assetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');

for (const file of readdirSync(assetsDir).filter((f) => f.endsWith('.js'))) {
  test(`문법 검사: public/assets/${file}`, () => {
    const result = spawnSync(process.execPath, ['--check', path.join(assetsDir, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
}
