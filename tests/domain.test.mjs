import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProject, providerInput, splitStoryboard, dimensions } from '../server/domain.mjs';
import { FalProvider, queueURL, mediaURL } from '../server/provider.mjs';
import { Auth } from '../server/auth.mjs';

const project = extra => validateProject({ title: 'A real film', scenes: [{ prompt: 'A paper boat glides down a stream.', duration: 5 }], ...extra });
test('project validation constrains real provider capabilities', () => {
  for (const change of [{ scenes: [] }, { resolution: '8K' }, { aspectRatio: '2:1' }, { scenes: [{ prompt: 'test', duration: 7 }] }, { scenes: [{ prompt: 'test', seed: -1 }] }, { audioMode: 'invalid' }]) assert.throws(() => project(change));
  assert.equal(project().audioMode, 'silent');
  assert.throws(() => project({ scenes: Array.from({ length: 9 }, () => ({ prompt: 'hello' })) }));
});
test('provider input preserves character, seed, settings, and first-frame semantics', () => {
  const p = project({ character: 'A small blue robot in a yellow coat', aspectRatio: '9:16' });
  const input = providerInput(p, p.scenes[0]);
  assert.match(input.prompt, /small blue robot/); assert.equal(input.seed, 42); assert.equal(input.aspect_ratio, '9:16');
  assert.equal(input.enable_safety_checker, true); assert.equal(input.duration, '5');
  const image = providerInput(p, p.scenes[0], 'data:image/png;base64,abc');
  assert.equal(image.image_url, 'data:image/png;base64,abc'); assert.equal(image.aspect_ratio, undefined);
});
test('manual storyboard splitting is faithful and validates overlong scenes', () => {
  const scenes = splitStoryboard('A boat moves.\n\nIt reaches the shore.');
  assert.equal(scenes.length, 2); assert.equal(scenes[1].prompt, 'It reaches the shore.');
  assert.throws(() => splitStoryboard('x'.repeat(851)));
});
test('frame dimensions are even and match supported orientations', () => {
  assert.deepEqual(dimensions('16:9', '720p'), [1280,720]);
  assert.deepEqual(dimensions('9:16', '1080p'), [1080,1920]);
  assert.deepEqual(dimensions('1:1', '480p'), [480,480]);
});
test('provider queue and download URLs reject secret forwarding and arbitrary destinations', () => {
  for (const url of ['https://evil.test/job', 'http://queue.fal.run/job', 'https://queue.fal.run.evil.test/job', 'https://user:pass@queue.fal.run/job']) assert.throws(() => queueURL(url));
  for (const url of ['http://127.0.0.1/video', 'https://example.com/video', 'file:///etc/passwd', 'https://fal.media.evil.test/video', 'https://storage.googleapis.com/another-bucket/video']) assert.throws(() => mediaURL(url));
  assert.equal(mediaURL('https://v3.fal.media/clip.mp4'), 'https://v3.fal.media/clip.mp4');
});
test('fal submission uses the documented input and persisted response URLs', async () => {
  let called;
  const provider = new FalProvider('test-key', async (url, init) => {
    called = { url, ...init };
    return Response.json({ request_id: 'r1', status_url: 'https://queue.fal.run/job/r1/status', response_url: 'https://queue.fal.run/job/r1', cancel_url: 'https://queue.fal.run/job/r1/cancel' });
  });
  const p = project(); const handle = await provider.submit(p, p.scenes[0]);
  assert.match(called.url, /wan-25-preview\/text-to-video$/); assert.equal(called.headers.Authorization, 'Key test-key');
  assert.equal(JSON.parse(called.body).duration, '5'); assert.equal(called.redirect, 'error'); assert.equal(handle.requestId, 'r1');
});
test('provider errors never masquerade as completed video', async () => {
  await assert.rejects(() => new FalProvider('').status({ statusURL:'https://queue.fal.run/x' }), /FAL_KEY/);
  const provider = new FalProvider('key', async () => new Response('no', { status: 401 }));
  await assert.rejects(() => provider.status({ statusURL:'https://queue.fal.run/x' }), /rejected/);
  const empty = new FalProvider('key', async () => Response.json({}));
  await assert.rejects(() => empty.result({ resultURL:'https://queue.fal.run/x' }), /no video/);
});
test('signed login rejects tampering, cross-site requests, and rebinding hosts', () => {
  const auth = new Auth('a-very-long-test-password', 'https://toon.example');
  const req = { headers: { host: 'toon.example' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(auth.authenticated(req), false);
  const cookie = auth.login(req, 'a-very-long-test-password');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/);
  req.headers.cookie = cookie.split(';')[0]; assert.equal(auth.authenticated(req), true);
  req.headers.cookie += 'x'; assert.equal(auth.authenticated(req), false);
  assert.throws(() => auth.checkOrigin({ headers: { host:'toon.example', origin:'https://evil.test' } }));
  assert.throws(() => auth.checkOrigin({ headers: { host:'evil.test' } }));
});
