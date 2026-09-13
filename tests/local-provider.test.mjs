import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { LocalProvider } from '../server/local-provider.mjs';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { inspect } from '../server/media.mjs';
import { validateProject } from '../server/domain.mjs';

const project = () => validateProject({title:'Local film',resolution:'480p',aspectRatio:'16:9',scenes:[{prompt:'A robot walks through a park.',duration:5}]});
const id = '12345678-1234-1234-1234-123456789012';
test('local submissions send the stable request key and never send a fal authorization', async () => {
  let sent;
  const provider = new LocalProvider('http://127.0.0.1:8188','local-secret',async (url, init) => { sent={url,...init};return Response.json({request_id:id}); });
  const p=project(),handle=await provider.submit(p,p.scenes[0],undefined,'render:0');
  assert.equal(provider.paid,false);assert.equal(provider.identity,'local:http://127.0.0.1:8188');
  assert.equal(sent.headers.Authorization,'Bearer local-secret');assert.equal(sent.headers['Idempotency-Key'],'render:0');
  assert.equal(JSON.parse(sent.body).duration,5);assert.equal(handle.providerKind,'local');
});
test('local adapter rejects unsupported duration and downloads outside its configured service', async () => {
  const provider = new LocalProvider('http://localhost:8188','secret',()=>{throw Error('must not fetch');});
  const p=project();p.scenes[0].duration=10;assert.throws(()=>provider.validate(p),/5-second/);
  await assert.rejects(()=>provider.download('https://evil.test/video','/tmp/not-written'),/outside/);
  assert.throws(()=>provider.handlePath({providerKind:'fal',requestId:id}),/different GPU/);
  assert.throws(()=>new LocalProvider('https://user:secret@example.com/','secret'));
});
test('health distinguishes a configured endpoint from a GPU-ready service', async () => {
  const provider=new LocalProvider('http://localhost:8188','secret',async()=>Response.json({ready:false,reason:'No GPU'}));
  assert.equal(provider.configured,true);assert.equal((await provider.health()).ready,false);
  const missing=new LocalProvider(undefined,undefined);assert.equal((await missing.health()).ready,false);
});
test('resuming a failed local generation explicitly retries its existing request', async () => {
  const calls=[];
  const local=new LocalProvider('http://localhost:8188','secret',async (url,init)=>{calls.push({url,...init});return Response.json({status:init.method==='POST'?'IN_QUEUE':'FAILED'});});
  await local.resume({providerIdentity:local.identity,scenes:[{status:'generating',handle:{providerKind:'local',serviceOrigin:local.base,requestId:id}}]});
  assert.equal(calls.length,2);assert.match(calls[1].url,/\/retry$/);assert.equal(calls[1].method,'POST');
});
test('switching providers never forwards an old fal request to the local worker', async t => {
  const root=await mkdtemp(join(tmpdir(),'toon-switch-'));const store=new Store(root);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const p=store.saveProject(project()),job=store.addJob(p,'key','fal');
  let calls=0;const local=new LocalProvider('http://localhost:8188','secret',async()=>{calls++;throw Error('must not fetch');});
  const engine=new Engine(store,local,root);await engine.tick();
  assert.equal(calls,0);assert.equal(store.job(job.id).status,'failed');assert.match(store.job(job.id).error,/different video backend/);
});
test('local uncertain submissions are recoverable using the same idempotency key', async t => {
  const root=await mkdtemp(join(tmpdir(),'toon-recover-local-'));const store=new Store(root);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const local=new LocalProvider('http://localhost:8188','secret',async()=>{throw Error('unreachable');});
  const p=store.saveProject(project()),job=store.addJob(p,'key','local',local.identity);
  job.status='running';job.scenes[0].status='submitting';store.saveJob(job);
  const engine=new Engine(store,local,root);engine.recover();assert.equal(store.job(job.id).status,'queued');
  await engine.tick();assert.equal(store.job(job.id).status,'failed');
});
test('Node engine and Python GPU queue interoperate through actual HTTP and MP4 files', {timeout:60000}, async t => {
  const root=await mkdtemp(join(tmpdir(),'toon-local-http-'));
  const token='integration-test-token-aaaaaaaaaaaaaaaaaaaa';
  // Only this test replaces diffusion with a deterministic FFmpeg video fixture.
  const code=`import sys,signal,threading\nfrom gpu_service.service import Queue,make_server\nq=Queue(sys.argv[1],probe=lambda:{'ready':True},command_factory=lambda req,out:['ffmpeg','-v','error','-y','-f','lavfi','-i','testsrc2=s=160x96:r=24','-t','0.5','-c:v','libx264',str(out)])\ns=make_server(q,sys.argv[2],port=0)\nq.start()\nprint(s.server_port,flush=True)\nsignal.signal(signal.SIGTERM,lambda *_:threading.Thread(target=s.shutdown,daemon=True).start())\ntry:s.serve_forever()\nfinally:s.server_close();q.close()\n`;
  const child=spawn('python3',['-u','-c',code,join(root,'gpu'),token],{stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}await rm(root,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{let buffer='';const timeout=setTimeout(()=>reject(Error('GPU fixture did not start: '+stderr)),10000);child.once('error',reject);child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){clearTimeout(timeout);resolve(Number(buffer.trim()));}});});
  const local=new LocalProvider(`http://127.0.0.1:${port}`,token),store=new Store(join(root,'studio'));
  t.after(()=>store.close());
  const p=store.saveProject(project()),job=store.addJob(p,'key','local',local.identity);
  const engine=new Engine(store,local,join(root,'studio'),{pollInterval:50});await engine.tick();
  const done=store.job(job.id);assert.equal(done.status,'completed',done.error);
  assert.equal(done.scenes[0].handle.providerKind,'local');
  const media=await inspect(join(root,'studio','renders',job.id,'final.mp4'));
  assert.equal(media.streams[0].codec_name,'h264');assert(Math.abs(Number(media.format.duration)-5)<0.2);
});
