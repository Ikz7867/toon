import { AppError, providerInput } from './domain.mjs';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';

const BASE = 'https://queue.fal.run/';
const TEXT_MODEL = 'fal-ai/wan-25-preview/text-to-video';
const IMAGE_MODEL = 'fal-ai/wan-25-preview/image-to-video';
export function queueURL(value) {
  const url = new URL(value);
  if (url.origin !== 'https://queue.fal.run' || url.username || url.password) throw new AppError('Provider returned an untrusted queue URL.', 502);
  return url.href;
}
export function mediaURL(value) {
  const url = new URL(value);
  const allowed = url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media') ||
    (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/falserverless/'));
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowed) throw new AppError('Provider returned an untrusted media URL.', 502);
  return url.href;
}
export class FalProvider {
  kind = 'fal'; identity = 'fal'; name = 'Wan 2.5 · fal'; paid = true;
  constructor(key, fetcher = fetch) { this.key = key; this.fetcher = fetcher; }
  get configured() { return Boolean(this.key); }
  async request(url, method = 'GET', body) {
    if (!this.key) throw new AppError('Video generation needs FAL_KEY on the server. You can still import clips and export.', 503, 'provider_not_configured');
    const response = await this.fetcher(queueURL(url), {
      method, headers: { Authorization: `Key ${this.key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403 ? 'Video provider rejected the API key or model access.' :
        response.status === 429 ? 'Video provider rate limit reached. Resume this render later.' :
        response.status === 422 ? 'Video provider rejected this scene. Check the prompt or reference image.' : `Video provider returned HTTP ${response.status}.`;
      throw new AppError(message, 502, `provider_${response.status}`);
    }
    return response.status === 204 ? {} : response.json();
  }
  async submit(project, scene, imageData) {
    const model = imageData ? IMAGE_MODEL : TEXT_MODEL;
    const result = await this.request(BASE + model, 'POST', providerInput(project, scene, imageData));
    if (!result.request_id || !result.status_url || !result.response_url || !result.cancel_url) throw new AppError('Video provider did not return a complete request handle.', 502);
    return { requestId: result.request_id, statusURL: queueURL(result.status_url), resultURL: queueURL(result.response_url), cancelURL: queueURL(result.cancel_url), model };
  }
  status(handle) { return this.request(handle.statusURL); }
  async result(handle) {
    const data = await this.request(handle.resultURL);
    if (!data.video?.url) throw new AppError('Video provider returned no video. The request may have failed moderation.', 502);
    return mediaURL(data.video.url);
  }
  cancel(handle) { return this.request(handle.cancelURL, 'PUT'); }
  async download(url, path) {
    let current = mediaURL(url), response;
    for (let redirect = 0; redirect < 4; redirect++) {
      response = await this.fetcher(current, { redirect: 'manual', signal: AbortSignal.timeout(180000) });
      if (response.status >= 300 && response.status < 400) { current = mediaURL(new URL(response.headers.get('location'), current).href); continue; }
      break;
    }
    if (!response?.ok || !response.body) throw new AppError('Could not download the generated video.', 502);
    let size = 0;
    const limit = new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length; callback(size > 250 * 1024 * 1024 ? new Error('Generated video exceeds 250 MB.') : null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(path));
  }
}
