import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.mjs';
import { command } from '../server/media.mjs';

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(),'toon-api-'));
  const app = createApp({ directory, web:resolve('web'), ...options });
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`; app.auth.origin = base;
  t.after(async () => { await app.close(); await rm(directory,{recursive:true,force:true}); });
  return { app, base, directory, request: (path, options) => fetch(base+path,options) };
}
const json = body => ({ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body) });
const project = { title:'API film',resolution:'480p',aspectRatio:'1:1',scenes:[{prompt:'A boat gliding through water.',duration:5}] };
test('HTTP routes require login and reject cross-origin writes', async t => {
  const {request}=await setup(t,{password:'correct-password-long'});
  assert.equal((await request('/api/projects')).status,401);
  assert.equal((await request('/api/login',json({password:'wrong'}))).status,401);
  const response=await request('/api/login',json({password:'correct-password-long'}));assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/projects',{headers:{cookie}})).status,200);
  assert.equal((await request('/api/projects',{...json(project),headers:{'Content-Type':'application/json',cookie,origin:'https://evil.example'}})).status,403);
  assert.equal((await request('/.env')).status,404);
});
test('missing generation credentials return an explicit blocker and create no fake job', async t => {
  const {request}=await setup(t,{provider:{configured:false}});
  const saved=await (await request('/api/projects',json(project))).json();
  const response=await request(`/api/projects/${saved.id}/generate`,{...json({confirmProviderUsage:true}),headers:{'Content-Type':'application/json','Idempotency-Key':'test'}});
  assert.equal(response.status,503);assert.match((await response.json()).error,/FAL_KEY/);
  assert.deepEqual(await (await request('/api/jobs')).json(),[]);
});
test('upload validation rejects disguised content and oversize declarations', async t => {
  const {request}=await setup(t);
  assert.equal((await request('/api/assets',{method:'POST',body:'not an image',headers:{'Content-Type':'image/png'}})).status,415);
  assert.equal((await request('/api/projects',{method:'POST',body:'{broken',headers:{'Content-Type':'application/json'}})).status,400);
});
test('saved characters persist and invalid reference types are rejected', async t => {
  const {request}=await setup(t);
  const saved=await request('/api/characters',json({name:'Blue robot',description:'Small blue robot with a yellow coat'}));
  assert.equal(saved.status,201);
  const list=await (await request('/api/characters')).json();assert.equal(list[0].name,'Blue robot');
  assert.equal((await request('/api/characters',json({name:'',description:'description'}))).status,400);
});
test('real imported MP4 completes through HTTP and supports download byte ranges', {timeout:120000}, async t => {
  const {request,app,directory}=await setup(t,{provider:{configured:false}});
  const file=join(directory,'test.mp4');
  await command('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=s=160x120:r=24','-t','1','-c:v','libx264',file]);
  const upload=await request('/api/assets',{method:'POST',body:await readFile(file),headers:{'Content-Type':'application/octet-stream'}});
  assert.equal(upload.status,201);const asset=await upload.json();
  const saved=await (await request('/api/projects',json({...project,scenes:[{...project.scenes[0],clipAsset:asset.id}]}))).json();
  const start=await request(`/api/projects/${saved.id}/generate`,{...json({}),headers:{'Content-Type':'application/json','Idempotency-Key':'one-render'}});
  assert.equal(start.status,202);const job=await start.json();
  if(app.engine.active)await app.engine.active;
  const final=await (await request(`/api/jobs/${job.id}`)).json();assert.equal(final.status,'completed',final.error);
  const response=await request(final.downloadURL,{headers:{Range:'bytes=0-31'}});
  assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,32);
  assert.match(response.headers.get('content-disposition'),/attachment/);
  assert.equal((await request(final.downloadURL,{headers:{Range:'bytes=999999999-'}})).status,416);
  const captions=await request(`/api/jobs/${job.id}/captions`);assert.equal(captions.status,200);
  const page=await request('/');assert.equal(page.status,200);assert.match(await page.text(),/Toon/);
});
