import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { FalProvider } from './provider.mjs';
import { Engine } from './engine.mjs';
import { Auth } from './auth.mjs';
import { AppError, validateProject, splitStoryboard, text } from './domain.mjs';
import { ffmpegAvailable, validateMedia } from './media.mjs';

export async function readBody(req, maximum = 128 * 1024) {
  if (Number(req.headers['content-length']) > maximum) throw new AppError('Upload exceeds the size limit.', 413);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new AppError('Upload exceeds the size limit.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Use application/json.', 415);
  try { return JSON.parse((await readBody(req)).toString()); }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError('Invalid JSON.'); }
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body));
}
function publicJob(job) {
  return { ...job, idempotencyKey: undefined, scenes: job.scenes.map(scene => ({ status: scene.status, file: scene.file })),
    downloadURL: job.status === 'completed' ? `/api/jobs/${job.id}/download` : null };
}
export async function streamFile(req, res, path, type, downloadName) {
  const info = await stat(path).catch(() => { throw new AppError('File not found.', 404); });
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...(downloadName ? { 'Content-Disposition': `attachment; filename="${downloadName}"` } : {}) };
  let start = 0, end = info.size - 1, status = 200;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!range || (!range[1] && !range[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
    if (!range[1]) start = Math.max(0, info.size - Number(range[2]));
    else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
    if (start > end || start >= info.size || !Number.isSafeInteger(start)) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
function sniff(data) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { kind: 'image', extension: 'png', mime: 'image/png' };
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return { kind: 'image', extension: 'jpg', mime: 'image/jpeg' };
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', extension: 'webp', mime: 'image/webp' };
  if (data.toString('ascii', 4, 8) === 'ftyp') return { kind: 'video', extension: 'mp4', mime: 'video/mp4' };
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') return { kind: 'audio', extension: 'wav', mime: 'audio/wav' };
  if (data.toString('ascii', 0, 3) === 'ID3' || (data[0] === 255 && (data[1] & 224) === 224)) return { kind: 'audio', extension: 'mp3', mime: 'audio/mpeg' };
  throw new AppError('Use PNG, JPEG, WebP, MP4, MP3 or WAV files.', 415);
}
export function createApp(options = {}) {
  const directory = resolve(options.directory ?? process.env.DATA_DIR ?? './data');
  const web = resolve(options.web ?? './web');
  const origin = options.origin ?? process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000';
  const store = new Store(directory);
  const provider = options.provider ?? new FalProvider(process.env.FAL_KEY);
  const engine = new Engine(store, provider, directory, options.engineOptions);
  const auth = new Auth(options.password ?? process.env.STUDIO_PASSWORD ?? '', origin);
  const mediaReady = ffmpegAvailable();
  const plannerURL = options.plannerURL ?? process.env.OLLAMA_URL;
  const plannerModel = options.plannerModel ?? process.env.OLLAMA_MODEL;
  function validateAssets(project) {
    for (const [id, kind] of [[project.referenceAsset, 'image'], [project.narrationAsset, 'audio'], ...project.scenes.flatMap(s => [[s.referenceAsset, 'image'], [s.clipAsset, 'video']])]) {
      if (id && store.asset(id).kind !== kind) throw new AppError(`Expected a ${kind} asset.`);
    }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      auth.checkOrigin(req);
      const path = new URL(req.url, origin).pathname;
      const method = req.method;
      if (path === '/api/health' && method === 'GET') return send(res, 200, { ok: true, authenticated: auth.authenticated(req), requiresLogin: Boolean(auth.password) });
      if (path === '/api/login' && method === 'POST') {
        const body = await jsonBody(req);
        return send(res, 200, { ok: true }, { 'Set-Cookie': auth.login(req, body.password) });
      }
      if (!path.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(method)) throw new AppError('Method not allowed.', 405);
        const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
        const file = files[path]; if (!file) throw new AppError('Page not found.', 404);
        return await streamFile(req, res, join(web, file[0]), file[1]);
      }
      auth.require(req);
      if (path === '/api/logout' && method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': 'toon_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      if (path === '/api/config' && method === 'GET') return send(res, 200, { provider: 'Wan 2.5 · fal', providerReady: provider.configured,
        mediaReady, plannerReady: Boolean(plannerURL && plannerModel), maxScenes: 8, durations: [5, 10], audioModes: ['silent', 'source'] });
      if (path === '/api/projects' && method === 'GET') return send(res, 200, store.projects());
      if (path === '/api/characters' && method === 'GET') return send(res, 200, store.characters());
      if (path === '/api/characters' && method === 'POST') {
        const body = await jsonBody(req);
        const name = text(body.name, 'Character name', 80, true);
        const description = text(body.description, 'Character description', 400, true);
        const referenceAsset = body.referenceAsset || null;
        if (referenceAsset && (typeof referenceAsset !== 'string' || store.asset(referenceAsset).kind !== 'image')) throw new AppError('Choose a reference image.');
        return send(res, 201, store.saveCharacter({ name, description, referenceAsset }));
      }
      if (path === '/api/projects' && method === 'POST') {
        const project = validateProject(await jsonBody(req)); validateAssets(project);
        return send(res, 201, store.saveProject(project));
      }
      let match;
      if ((match = /^\/api\/projects\/([a-f0-9-]{36})$/.exec(path))) {
        const current = store.project(match[1]);
        if (method === 'GET') return send(res, 200, current);
        if (method === 'PUT') {
          const body = await jsonBody(req);
          if (body.updated && body.updated !== current.updated) throw new AppError('This project was changed in another tab. Reload it before saving.', 409);
          const project = validateProject(body); validateAssets(project);
          return send(res, 200, store.saveProject(project, current.id));
        }
      }
      if ((match = /^\/api\/projects\/([a-f0-9-]{36})\/generate$/.exec(path)) && method === 'POST') {
        const project = store.project(match[1]);
        const body = await jsonBody(req);
        if (!mediaReady) throw new AppError('Install FFmpeg and FFprobe on the engine server first.', 503);
        if (!provider.configured && project.scenes.some(scene => !scene.clipAsset)) throw new AppError('Set FAL_KEY on the server to generate new video. Imported clips can be exported without it.', 503, 'provider_not_configured');
        if (project.scenes.some(scene => !scene.clipAsset) && body.confirmProviderUsage !== true) throw new AppError('Confirm that this render uses your provider credits.', 400);
        const key = text(req.headers['idempotency-key'], 'Idempotency key', 100, true);
        const job = store.addJob(project, key); engine.tick(); return send(res, 202, publicJob(job));
      }
      if (path === '/api/jobs' && method === 'GET') return send(res, 200, store.jobs().map(publicJob));
      if ((match = /^\/api\/jobs\/([a-f0-9-]{36})(?:\/(cancel|resume|download|captions|scene-\d+))?$/.exec(path))) {
        const job = store.job(match[1]), action = match[2];
        if (!action && method === 'GET') return send(res, 200, publicJob(job));
        if (action === 'cancel' && method === 'POST') {
          if (!['queued', 'running'].includes(job.status)) throw new AppError('This render is no longer active.', 409);
          job.cancelRequested = true;
          if (job.status === 'queued' && !job.scenes.some(scene => scene.handle)) { job.status = 'cancelled'; job.stage = 'Cancelled before starting'; }
          store.saveJob(job); return send(res, 200, publicJob(job));
        }
        if (action === 'resume' && method === 'POST') {
          if (job.status !== 'failed') throw new AppError('Only a failed render can be resumed. Unconfirmed submissions need a provider queue check.', 409);
          if (store.jobs(job.projectId).some(j => ['queued', 'running'].includes(j.status))) throw new AppError('Another render is already active for this project.', 409);
          job.status = 'queued'; job.cancelRequested = false; job.error = null; store.saveJob(job); engine.tick(); return send(res, 202, publicJob(job));
        }
        if (['GET', 'HEAD'].includes(method)) {
          if (action?.startsWith('scene-')) {
            const scene = job.scenes[Number(action.slice(6))];
            if (!scene?.file || scene.status !== 'done') throw new AppError('Scene is not ready.', 409);
            return await streamFile(req, res, join(directory, 'renders', job.id, scene.file), 'video/mp4');
          }
          if (job.status !== 'completed') throw new AppError('Render is not ready.', 409);
          if (action === 'download') return await streamFile(req, res, join(directory, 'renders', job.id, 'final.mp4'), 'video/mp4', new URL(req.url, origin).searchParams.has('inline') ? null : 'toon-video.mp4');
          if (action === 'captions') return await streamFile(req, res, join(directory, 'renders', job.id, 'captions.srt'), 'application/x-subrip', 'toon-captions.srt');
        }
      }
      if (path === '/api/assets' && method === 'POST') {
        if (!mediaReady) throw new AppError('FFmpeg and FFprobe are required to validate uploads.', 503);
        const bytes = await readBody(req, 100 * 1024 * 1024);
        const details = sniff(bytes);
        if (bytes.length > (details.kind === 'image' ? 10 : details.kind === 'audio' ? 20 : 100) * 1024 * 1024) throw new AppError('File is too large for this media type.', 413);
        const file = `${randomUUID()}.${details.extension}`;
        await mkdir(join(directory, 'uploads'), { recursive: true });
        const destination = join(directory, 'uploads', file);
        await writeFile(destination, bytes);
        try { await validateMedia(destination, details.kind); }
        catch (error) { await unlink(destination); throw error; }
        const saved = store.saveAsset({ ...details, file, bytes: bytes.length });
        return send(res, 201, { id: saved.id, kind: saved.kind, url: `/api/assets/${saved.id}` });
      }
      if ((match = /^\/api\/assets\/([a-f0-9-]{36})$/.exec(path)) && ['GET', 'HEAD'].includes(method)) {
        const asset = store.asset(match[1]); return await streamFile(req, res, join(directory, 'uploads', asset.file), asset.mime);
      }
      if (path === '/api/storyboard' && method === 'POST') {
        const body = await jsonBody(req);
        const idea = text(body.idea, 'Story idea', 6000, true);
        if (body.mode !== 'ai') return send(res, 200, { method: 'paragraphs', scenes: splitStoryboard(idea) });
        if (!plannerURL || !plannerModel) throw new AppError('Configure OLLAMA_URL and OLLAMA_MODEL for AI script writing. Manual scene splitting is available now.', 503);
        const result = await fetch(new URL('/api/chat', plannerURL), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
          body: JSON.stringify({ model: plannerModel, stream: false, format: 'json', messages: [
            { role: 'system', content: 'Write an actionable storyboard for an AI video engine. Return JSON only: {"scenes":[{"prompt":"a concrete shot describing subject, action, camera, lighting (max 850 characters)","caption":"optional short caption","duration":5}]}. Use 1 to 8 scenes, each 5 or 10 seconds. Preserve the story and recurring character details. Do not claim to have rendered any video.' },
            { role: 'user', content: idea },
          ] }),
        });
        if (!result.ok) throw new AppError('The script-writing model could not complete this request.', 502);
        const data = await result.json(); let script;
        try { script = JSON.parse(data.message.content); } catch { throw new AppError('The script model returned invalid JSON. Try again or write scenes manually.', 502); }
        const validated = validateProject({ title: 'Storyboard', scenes: script.scenes });
        return send(res, 200, { method: 'ollama', scenes: validated.scenes });
      }
      throw new AppError('Endpoint not found.', 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof AppError ? error.status : 500;
      if (status === 500) console.error('Request failed:', error.message);
      send(res, status, { error: status === 500 ? 'The server could not complete this request.' : error.message, code: error.code ?? 'server_error' });
    }
  });
  server.requestTimeout = 180000; server.headersTimeout = 15000;
  return { server, store, engine, auth, async close() { await engine.stop(); await new Promise(resolve => server.close(resolve)); store.close(); } };
}
