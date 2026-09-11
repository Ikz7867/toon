import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { validateProject } from '../server/domain.mjs';
import { command, inspect, normalizeClip, assemble, subtitleText, referenceData } from '../server/media.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'toon-test-')); const store = new Store(root);
  t.after(async () => { store.close(); await rm(root, { recursive:true, force:true }); });
  return { root, store };
}
const sample = () => validateProject({ title: 'Engine test', resolution:'480p', aspectRatio:'1:1', scenes:[{ prompt:'A moving object crosses the frame.', duration:5, caption:'First scene' }] });
test('idempotency prevents duplicate jobs and active renders', async t => {
  const { store } = await fixture(t); const project = store.saveProject(sample());
  const first = store.addJob(project, 'same'); assert.equal(store.addJob(project,'same').id,first.id);
  assert.throws(() => store.addJob(project,'different'), /active render/);
});
test('recovery resumes known requests and quarantines unknown submissions', async t => {
  const { store, root } = await fixture(t);
  const p1 = store.saveProject(sample()), p2 = store.saveProject(sample());
  const known = store.addJob(p1, randomUUID()); known.status='running'; known.scenes[0]={ status:'generating', handle:{ requestId:'known' } }; store.saveJob(known);
  const unknown = store.addJob(p2,randomUUID()); unknown.status='running'; unknown.scenes[0].status='submitting'; store.saveJob(unknown);
  const engine = new Engine(store, {}, root); engine.recover();
  assert.equal(store.job(known.id).status,'queued'); assert.equal(store.job(unknown.id).status,'needs_review');
});
test('end-to-end engine uses provider handle, resumes polling, and exports actual silent video', { timeout:120000 }, async t => {
  const { store, root } = await fixture(t);
  const source = join(root,'fixture.mp4');
  await command('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=s=320x240:r=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',source]);
  let submissions=0, polls=0;
  const provider = { configured:true, async submit(){ submissions++; return {requestId:'persisted-request'}; }, async status(){ polls++; return { status:polls===1?'IN_PROGRESS':'COMPLETED' }; }, async result(){ return 'https://v3.fal.media/result.mp4'; }, async download(url,path){ await copyFile(source,path); } };
  const project = store.saveProject(sample()); const job = store.addJob(project,'render-key');
  const engine = new Engine(store,provider,root,{pollInterval:1});
  await engine.tick();
  const done = store.job(job.id); assert.equal(done.status,'completed',done.error); assert.equal(submissions,1); assert.equal(polls,2);
  const output = join(root,'renders',job.id,'final.mp4'); const info = await inspect(output);
  assert(info.streams.some(s=>s.codec_type==='video')); assert(!info.streams.some(s=>s.codec_type==='audio'));
  assert(Math.abs(Number(info.format.duration)-5)<0.2); assert((await stat(output)).size>1000);
  assert.equal(info.streams[0].width,480); assert.equal(info.streams[0].height,480);
});
test('saved provider request is never resubmitted after a transient polling failure', async t => {
  const { store, root } = await fixture(t);
  let submissions=0, polls=0;
  const provider = { async submit(){submissions++;return {requestId:'r'};},async status(){polls++;throw new Error('Temporary outage');} };
  const p=store.saveProject(sample()),job=store.addJob(p,'k'); const engine=new Engine(store,provider,root,{pollInterval:1});
  await engine.tick(); assert.equal(store.job(job.id).status,'failed');
  const retry=store.job(job.id);retry.status='queued';store.saveJob(retry);await engine.tick();
  assert.equal(submissions,1); assert.equal(polls,2);
});
test('uncertain provider submission is stopped for review, not automatically retried', async t => {
  const { store, root } = await fixture(t);
  const provider={async submit(){throw new Error('Connection closed after submission');}};
  const p=store.saveProject(sample()),job=store.addJob(p,'key'); const engine=new Engine(store,provider,root);
  await engine.tick(); assert.equal(store.job(job.id).status,'needs_review');
});
test('cancelled running job calls remote cancellation and produces no success', async t => {
  const { store, root } = await fixture(t);let cancelled=0;
  const p=store.saveProject(sample()),job=store.addJob(p,'key'); job.cancelRequested=true;job.scenes[0]={status:'generating',handle:{requestId:'r'}};store.saveJob(job);
  const engine=new Engine(store,{async cancel(){cancelled++;}},root);await engine.tick();
  assert.equal(store.job(job.id).status,'cancelled');assert.equal(cancelled,1);
});
test('real multi-scene assembly burns captions and retains optional audio', { timeout:120000 }, async t => {
  const { root }=await fixture(t);const source=join(root,'input.mp4');
  await command('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=s=160x120:r=24','-f','lavfi','-i','sine=frequency=500','-t','1','-c:v','libx264','-c:a','aac',source]);
  const p=sample();p.audioMode='source';p.captions=true;p.scenes.push({...p.scenes[0],caption:'Second scene'});
  const clips=[join(root,'one.mp4'),join(root,'two.mp4')];
  for(let i=0;i<clips.length;i++)await normalizeClip(source,clips[i],p,p.scenes[i]);
  const result=await assemble(clips,join(root,'export'),p);const info=await inspect(result.output);
  assert(info.streams.some(s=>s.codec_type==='audio'));assert(Math.abs(result.duration-10)<0.3);
  assert.match(subtitleText(p),/00:00:05,000 --> 00:00:10,000/);
});
test('reference image preprocessing produces a real portrait PNG data URI', async t => {
  const {root}=await fixture(t);const image=join(root,'input.png');
  await command('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=400x400','-frames:v','1','-threads','1',image]);
  const data=await referenceData(image,'9:16',root);
  assert.match(data,/^data:image\/png;base64,iVBOR/);
  const info=await inspect(join(root,'reference.png'));assert.equal(info.streams[0].width,720);assert.equal(info.streams[0].height,1280);
});
