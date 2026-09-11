import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
for (const directory of ['server', 'web', 'tests', 'scripts']) {
  for (const file of readdirSync(directory).filter(name => /\.(mjs|js)$/.test(name))) {
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(1);
  }
}
const html = readFileSync('web/index.html', 'utf8');
for (const path of ['/app.js', '/styles.css', '/favicon.svg']) assert(html.includes(path), `Missing asset ${path}`);
assert(!readFileSync('web/app.js', 'utf8').includes('Authorization: Key'), 'Provider credentials must stay on the server');
console.log('JavaScript syntax and static asset references passed.');
