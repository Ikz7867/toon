import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { AppError, buildPrompt } from './domain.mjs';

// This URL is administrator configuration, never user-controlled request input.
export class LocalProvider {
  kind = 'local'; name = 'Wan 2.2 · Your GPU'; paid = false; idempotentSubmission = true;
  constructor(url, token, fetcher = fetch) {
    this.token = token; this.fetcher = fetcher;
    if (url) {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('SELF_HOSTED_URL must be an HTTP(S) origin without a path or embedded credentials.');
      this.base = parsed.origin;
    }
  }
  get configured() { return Boolean(this.base && this.token); }
  get identity() { return this.base ? `local:${this.base}` : 'local:unconfigured'; }
  url(path) {
    if (!/^\/(health|requests(?:\/[a-f0-9-]{36}(?:\/(?:result|video|cancel|retry))?)?)$/.test(path)) throw new AppError('Invalid self-hosted operation.', 502);
    return `${this.base}${path}`;
  }
  handlePath(handle, suffix = '') {
    if (handle.providerKind !== 'local' || handle.serviceOrigin !== this.base || !/^[a-f0-9-]{36}$/.test(handle.requestId)) throw new AppError('This request belongs to a different GPU service. Restore its original server configuration to resume.', 409);
    return `/requests/${handle.requestId}${suffix}`;
  }
  async request(path, method = 'GET', body, requestKey) {
    if (!this.configured) throw new AppError('Configure SELF_HOSTED_URL and SELF_HOSTED_TOKEN to connect your GPU service.', 503, 'provider_not_configured');
    let response;
    try {
      response = await this.fetcher(this.url(path), { method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...(requestKey ? { 'Idempotency-Key': requestKey } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000) });
    } catch { throw new AppError('Your GPU service is unreachable. Check that it is running and SELF_HOSTED_URL is correct.', 503); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new AppError(typeof data.error === 'string' ? data.error.slice(0, 600) : `GPU service returned HTTP ${response.status}.`, response.status === 401 ? 503 : response.status);
    return data;
  }
  async health() {
    if (!this.configured) return { ready: false, reason: 'Configure SELF_HOSTED_URL and SELF_HOSTED_TOKEN.' };
    try { return await this.request('/health'); } catch (error) { return { ready: false, reason: error.message }; }
  }
  validate(project) {
    if (project.scenes.some(s => !s.clipAsset && s.duration !== 5)) throw new AppError('The local Wan profile generates 5-second scenes. Set generated scenes to 5 seconds; imported clips can still use 10 seconds.');
  }
  async submit(project, scene, imageData, requestKey) {
    this.validate({ scenes: [scene] });
    const result = await this.request('/requests', 'POST', {
      prompt: buildPrompt(project, scene), negative_prompt: 'text, subtitles, watermarks, static frame, distorted motion',
      duration: scene.duration, aspect_ratio: project.aspectRatio, resolution: project.resolution, seed: scene.seed,
      ...(imageData ? { image: imageData } : {}),
    }, requestKey);
    if (!/^[a-f0-9-]{36}$/.test(result.request_id)) throw new AppError('GPU service returned an invalid request ID.', 502);
    return { requestId: result.request_id, providerKind: 'local', serviceOrigin: this.base, model: 'Wan2.2-TI2V-5B' };
  }
  async status(handle) {
    const data = await this.request(this.handlePath(handle));
    if (['FAILED', 'CANCELLED'].includes(data.status)) throw new AppError(data.error || `GPU request ${data.status.toLowerCase()}.`, 502);
    return data;
  }
  async result(handle) {
    const result = await this.request(this.handlePath(handle, '/result'));
    if (result.status !== 'COMPLETED') throw new AppError('GPU video is not ready.', 409);
    // Do not trust any download URL returned by a remote service.
    return this.url(this.handlePath(handle, '/video'));
  }
  cancel(handle) { return this.request(this.handlePath(handle, '/cancel'), 'POST'); }
  async resume(job) {
    if (job.providerIdentity !== this.identity) throw new AppError('Restore the original GPU service before resuming this render.', 409);
    for (const scene of job.scenes) {
      if (scene.handle && !['done', 'downloaded'].includes(scene.status)) {
        const current = await this.request(this.handlePath(scene.handle));
        if (current.status === 'FAILED') await this.request(this.handlePath(scene.handle, '/retry'), 'POST');
      }
    }
  }
  async download(url, destination) {
    const parsed = new URL(url);
    if (parsed.origin !== this.base || !/^\/requests\/[a-f0-9-]{36}\/video$/.test(parsed.pathname) || parsed.search || parsed.hash || parsed.username || parsed.password) throw new AppError('Refusing a download outside the configured GPU service.', 502);
    const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${this.token}` }, redirect: 'error', signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new AppError('Could not download the GPU output.', 502);
    let bytes = 0;
    const limit = new Transform({ transform(chunk, _, callback) { bytes += chunk.length; callback(bytes > 250 * 1024 * 1024 ? new Error('GPU video exceeds 250 MB.') : null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(destination));
  }
}
