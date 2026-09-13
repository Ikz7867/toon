import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

const path = '.env';
let source = existsSync(path) ? readFileSync(path, 'utf8') : readFileSync('.env.example', 'utf8');
function set(key, value, preserve = false) {
  const regex = new RegExp(`^${key}=(.*)$`, 'm');
  const previous = source.match(regex)?.[1]?.trim();
  if (preserve && previous) return;
  source = regex.test(source) ? source.replace(regex, `${key}=${value}`) : `${source}\n${key}=${value}\n`;
}
set('VIDEO_PROVIDER', 'local');
set('SELF_HOSTED_URL', 'http://127.0.0.1:8188', true);
set('SELF_HOSTED_TOKEN', randomBytes(32).toString('hex'), true);
set('STUDIO_PASSWORD', randomBytes(24).toString('base64url'), true);
set('PROVIDER_TIMEOUT_MS', '7200000');
writeFileSync(path, source, { mode: 0o600 }); chmodSync(path, 0o600);
console.log('Self-hosted mode configured. The studio password and private worker token are saved in .env. No external API key was created or requested.');
