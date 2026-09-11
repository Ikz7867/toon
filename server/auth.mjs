import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from './domain.mjs';

const equal = (a, b) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export class Auth {
  constructor(password, origin) { this.password = password; this.origin = origin; this.attempts = new Map(); }
  signature(value) { return createHmac('sha256', this.password).update(value).digest('hex'); }
  authenticated(req) {
    if (!this.password) return true;
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('toon_session='))?.slice(13);
    if (!token) return false;
    const [expires, signature] = token.split('.');
    return Number(expires) > Date.now() && Number(expires) < Date.now() + 86401000 && equal(signature ?? '', this.signature(expires));
  }
  require(req) { if (!this.authenticated(req)) throw new AppError('Sign in to your studio.', 401, 'unauthorized'); }
  checkOrigin(req) {
    const allowed = new URL(this.origin);
    const host = req.headers.host;
    const localAlias = allowed.hostname === 'localhost' && host === `127.0.0.1:${allowed.port || '80'}`;
    if (host !== allowed.host && !localAlias) throw new AppError('Unrecognized host. Set PUBLIC_ORIGIN to your studio address.', 403);
    if (req.headers.origin && req.headers.origin !== this.origin) {
      const alias = `http://127.0.0.1:${allowed.port || '80'}`;
      if (!(allowed.hostname === 'localhost' && req.headers.origin === alias)) throw new AppError('Cross-origin requests are not allowed.', 403);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('Cross-site requests are not allowed.', 403);
  }
  login(req, password) {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    for (const [key, item] of this.attempts) if (now - item.start > 600000) this.attempts.delete(key);
    const entry = this.attempts.get(ip) ?? { start: now, count: 0 };
    if (++entry.count > 10) throw new AppError('Too many sign-in attempts. Try again in ten minutes.', 429);
    this.attempts.set(ip, entry);
    if (!this.password || !equal(String(password ?? ''), this.password)) throw new AppError('Incorrect studio password.', 401);
    this.attempts.delete(ip);
    const expires = String(now + 86400000);
    return `toon_session=${expires}.${this.signature(expires)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${this.origin.startsWith('https:') ? '; Secure' : ''}`;
  }
}
