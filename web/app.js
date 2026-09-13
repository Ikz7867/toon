const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
  play: 'm8 4 12 8-12 8Z', film: 'M4 3h16v18H4zM4 8h16M4 16h16M8 3v18M16 3v18',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  settings: 'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  plus: 'M12 4v16M4 12h16', arrow: 'M4 12h16M14 6l6 6-6 6', image: 'M3 3h18v18H3zM3 17l6-7 5 5 3-3 4 5M16 7h.01',
  down: 'M12 3v12M7 10l5 5 5-5M4 17v4h16v-4', save: 'M4 3h13l4 4v14H3V3h1M7 3v6h10V3M7 21v-8h10v8',
  info: 'M12 11v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  up: 'm6 14 6-6 6 6', chevron: 'm6 10 6 6 6-6', sparkle: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  check: 'm5 12 4 4L19 6', audio: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-3-3h3M20 16a3 3 0 1 1-3-3h3',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.film}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const selected = (a, b) => a === b ? 'selected' : '';
const scene = () => ({ prompt: '', caption: '', duration: 5, seed: 42, referenceAsset: null, clipAsset: null });
const blank = () => ({ title: 'Untitled film', idea: '', character: '', referenceAsset: null, narrationAsset: null, style: 'cartoon', aspectRatio: '16:9', resolution: '720p', captions: false, audioMode: 'silent', scenes: [scene()] });
let project = blank(), projects = [], jobs = [], characters = [], config = {}, view = 'studio', dirty = false, busy = false, renderKey = null, poll, toastTimer;
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/login') showLogin(); throw new Error(data.error || 'Request failed.'); }
  return data;
}
function toast(message, error = false) {
  $('#toast').textContent = message; $('#toast').className = error ? 'error' : ''; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 9000 : 4500);
}
async function attempt(fn) { try { await fn(); } catch (error) { toast(error.message, true); } }
function brand() { return `<div class="brand"><span class="brand-mark">${icon('play')}</span>toon<span class="version">STUDIO</span></div>`; }
function markDirty() { dirty = true; const indicator = $('#save-label'); if (indicator) indicator.textContent = 'Unsaved changes'; }
function currentJob() { return jobs.find(job => job.projectId === project.id); }
function totalSeconds() { return project.scenes.reduce((sum, item) => sum + Number(item.duration), 0); }
function shell(content) {
  $('#app').innerHTML = `<div class="shell"><aside class="sidebar">${brand()}<nav class="navigation" aria-label="Main navigation">
    ${[['studio', 'film', 'Video studio'], ['library', 'grid', 'My videos'], ['settings', 'settings', 'Engine settings']].map(([key, glyph, label]) => `<button class="nav-button ${view === key ? 'active' : ''}" data-view="${key}" aria-label="${label}" ${view === key ? 'aria-current="page"' : ''}>${icon(glyph)}${label}</button>`).join('')}
    </nav><section class="project-nav"><div class="project-heading"><span class="eyebrow">Projects</span><button class="quiet icon-button small" data-action="new" aria-label="New project">${icon('plus')}</button></div>
    ${projects.length ? projects.map(p => `<button class="project-item ${p.id === project.id ? 'active' : ''}" data-project="${p.id}" title="${escape(p.title)}">${escape(p.title)}</button>`).join('') : '<p class="muted small">Your saved films appear here.</p>'}</section>
    <div class="side-bottom"><strong>Your next story starts here.</strong><br>Write. Generate. Assemble.</div></aside>
    <main class="main"><header class="topbar"><div class="breadcrumbs"><span>Workspace</span><span>/</span><strong>${escape(view === 'studio' ? project.title : view === 'library' ? 'My videos' : 'Engine settings')}</strong></div><div class="top-actions"><span id="save-label" class="muted small">${dirty ? 'Unsaved changes' : project.id ? 'Saved' : 'New project'}</span><button class="quiet small" data-action="new">${icon('plus')}New film</button>${view === 'studio' ? `<button class="small" data-action="save">${icon('save')}Save</button>` : ''}</div></header><div class="workspace">${content}</div></main></div>`;
}
function settingsNotice() {
  if (!config.mediaReady) return `<div class="notice error">${icon('info')}<p>The export engine needs FFmpeg and FFprobe. Open Engine settings for setup.</p></div>`;
  if (!config.providerReady) return `<div class="notice">${icon('info')}<p>Connect the video model in <button class="quiet small" data-view="settings">Engine settings</button> to generate new footage. ${escape(config.providerReason || '')} You can import your own clips and export now.</p></div>`;
  return '';
}
function studio() {
  shell(`<div class="heading"><div><h1>Video studio</h1><p>Turn your idea into moving scenes. Shape every shot.</p></div><span class="badge">${escape(config.provider || 'Video engine')}</span></div>
    <div class="studio-grid"><section class="card"><div class="card-head"><h2><span class="step">01</span>Creative brief</h2>${icon('sparkle')}</div><div class="card-body">
    <div class="field"><label for="title">Film title</label><input id="title" data-field="title" maxlength="100" value="${escape(project.title)}"></div>
    <div class="field"><label for="idea">What happens in your video?</label><textarea id="idea" class="idea-input" data-field="idea" maxlength="6000" placeholder="Describe the setting, characters, and what happens. Separate paragraphs become separate scenes.">${escape(project.idea)}</textarea></div>
    <div class="button-row"><button class="small" data-action="split">${icon('film')}Split into scenes</button><button class="quiet small" data-action="plan" ${!config.plannerReady ? 'disabled title="Connect an Ollama model in Engine settings"' : ''}>${icon('sparkle')}Write with AI</button></div>
    <hr class="divider"><div class="field-row"><div class="field"><label for="style">Visual style</label><select id="style" data-field="style">${[['cartoon','3D animation'],['illustration','2D illustration'],['cinematic','Cinematic'],['clay','Clay animation']].map(([v,l]) => `<option value="${v}" ${selected(project.style,v)}>${l}</option>`).join('')}</select></div><div class="field"><label for="format">Format</label><select id="format" data-field="aspectRatio">${[['16:9','16:9 · Landscape'],['9:16','9:16 · Portrait'],['1:1','1:1 · Square']].map(([v,l]) => `<option value="${v}" ${selected(project.aspectRatio,v)}>${l}</option>`).join('')}</select></div></div>
    <div class="field"><label for="character">Recurring character</label><textarea id="character" data-field="character" maxlength="400" placeholder="Name, appearance, clothing, and details to preserve in each scene…">${escape(project.character)}</textarea><small>This description is reused in every generated shot. Visual consistency still depends on the model.</small></div>
    <div class="button-row character-actions"><button class="quiet small" data-action="save-character">${icon('save')}Save character</button><button class="quiet small" data-action="load-character" ${characters.length ? '' : 'disabled'}>Load character</button></div>
    <div class="reference">${project.referenceAsset ? `<img class="reference-preview" src="/api/assets/${project.referenceAsset}" alt="Character reference">` : icon('image')}<div class="reference-text"><p>${project.referenceAsset ? 'Reference image attached' : 'Add a starting image'}</p><small>PNG, JPG or WebP · up to 10 MB</small></div><button class="quiet small" data-action="reference">${project.referenceAsset ? 'Replace' : 'Upload'}</button>${project.referenceAsset ? '<button class="quiet small" data-action="clear-reference" aria-label="Remove reference">×</button>' : ''}</div>
    </div></section><div class="preview-column"><section class="card"><div class="card-head"><h2><span class="step">02</span>Preview</h2><span class="badge" id="preview-badge">${escape(project.aspectRatio)}</span></div><div id="player-area"></div><div id="render-status"></div></section>
    <section class="card timeline"><div class="card-head"><h2>Output settings</h2>${icon('settings')}</div><div class="card-body"><div class="field-row"><div class="field"><label for="resolution">Resolution</label><select id="resolution" data-field="resolution">${['480p','720p','1080p'].map(v => `<option ${selected(project.resolution,v)}>${v}</option>`).join('')}</select></div><div class="field"><label for="audioMode">Scene audio</label><select id="audioMode" data-field="audioMode"><option value="silent" ${selected(project.audioMode,'silent')}>Silent</option><option value="source" ${selected(project.audioMode,'source')}>Keep model / clip audio</option></select></div></div>
    <label class="check-row"><input type="checkbox" data-field="captions" ${project.captions ? 'checked' : ''}>Burn scene captions into the video</label><div class="button-row"><button class="quiet small" data-action="narration">${icon('audio')}${project.narrationAsset ? 'Replace narration' : 'Add narration recording'}</button>${project.narrationAsset ? '<button class="quiet small" data-action="clear-narration">Remove</button><span class="pending-label">Recording attached</span>' : ''}</div><p class="muted small">An uploaded recording replaces scene audio and is included as-is.</p></div></section>${settingsNotice()}</div></div>
    <section class="timeline"><div class="timeline-head"><div class="timeline-title"><h2><span class="step">03</span>Scene sequence</h2><span class="badge" id="timeline-meta">${project.scenes.length} scenes · ${totalSeconds()}s</span></div><button class="quiet small" data-action="add-scene" ${project.scenes.length >= 8 ? 'disabled' : ''}>${icon('plus')}Add scene</button></div><div id="scene-stack" class="scene-stack">${project.scenes.map(sceneCard).join('')}</div></section>
    <div class="render-bar"><p>Each scene becomes a real video clip.<br>Finished clips are joined into one MP4.</p><button class="primary" data-action="generate" ${busy ? 'disabled' : ''}>${icon('sparkle')}Generate video${icon('arrow')}</button></div>`);
  updateRender(true);
}
function sceneCard(item, index) {
  return `<article class="scene" data-scene="${index}"><div class="scene-index">${String(index + 1).padStart(2,'0')}</div><div class="scene-fields"><div class="scene-title-row"><h3>Scene ${index + 1}</h3><div class="scene-actions"><button class="quiet" data-scene-action="up" data-index="${index}" ${index === 0 ? 'disabled' : ''} aria-label="Move scene ${index + 1} up">${icon('up')}</button><button class="quiet" data-scene-action="down" data-index="${index}" ${index === project.scenes.length - 1 ? 'disabled' : ''} aria-label="Move scene ${index + 1} down">${icon('chevron')}</button><button class="quiet danger" data-scene-action="delete" data-index="${index}" ${project.scenes.length < 2 ? 'disabled' : ''} aria-label="Delete scene ${index + 1}">${icon('trash')}</button></div></div><textarea aria-label="Scene ${index + 1} prompt" data-scene-field="prompt" data-index="${index}" maxlength="850" placeholder="Describe the action, camera movement, and setting for this shot…">${escape(item.prompt)}</textarea><input class="caption" aria-label="Scene ${index + 1} caption" data-scene-field="caption" data-index="${index}" maxlength="180" value="${escape(item.caption)}" placeholder="Optional caption for this scene"><div class="button-row"><button class="quiet small" data-scene-action="reference" data-index="${index}">${icon('image')}${item.referenceAsset ? 'Change scene image' : 'Scene image'}</button>${item.referenceAsset ? `<button class="quiet small" data-scene-action="clear-reference" data-index="${index}">Remove image</button>` : ''}${item.clipAsset ? `<button class="quiet small" data-scene-action="clear-clip" data-index="${index}">Remove imported clip</button>` : ''}</div></div><div class="scene-controls"><div><label for="duration-${index}">Duration</label><select id="duration-${index}" data-scene-field="duration" data-index="${index}"><option value="5" ${selected(Number(item.duration),5)}>5 seconds</option><option value="10" ${selected(Number(item.duration),10)} ${config.providerKind === 'local' && !item.clipAsset ? 'disabled' : ''}>10 seconds${config.providerKind === 'local' && !item.clipAsset ? ' · import only' : ''}</option></select></div><div><label for="seed-${index}">Seed</label><input id="seed-${index}" type="number" min="0" max="2147483647" data-scene-field="seed" data-index="${index}" value="${item.seed ?? 42}"></div><button class="quiet small" data-scene-action="clip" data-index="${index}">${item.clipAsset ? icon('check') : icon('film')}${item.clipAsset ? 'Clip attached' : 'Import MP4'}</button></div></article>`;
}
function updateRender(rebuildPlayer = false) {
  if (view !== 'studio' || !$('#render-status')) return;
  const job = currentJob();
  const ready = job?.status === 'completed';
  const previewKey = ready ? job.id : 'empty';
  if (rebuildPlayer || $('#player-area').dataset.previewKey !== previewKey) {
    $('#player-area').dataset.previewKey = previewKey;
    $('#player-area').innerHTML = `<div class="player">${ready ? `<video controls playsinline preload="metadata" src="/api/jobs/${job.id}/download?inline" aria-label="Rendered video"></video>` : `<div class="player-empty"><span class="play-emblem">${icon('play')}</span><h3>${job && ['queued','running'].includes(job.status) ? 'Your film is in progress' : 'Your film will appear here'}</h3><p>${job && ['queued','running'].includes(job.status) ? 'You can close this tab. The engine keeps working on the server.' : 'Write your scenes, choose your format, then generate your video.'}</p></div>`}</div><div class="monitor-footer"><span>${ready ? `${job.duration.toFixed(1)}s · MP4` : 'Preview monitor'}</span><span>${ready ? escape(job.project.resolution) : 'No video rendered yet'}</span></div>`;
  }
  $('#render-status').innerHTML = `<div class="status-content"><div class="status-top"><h3>${job ? escape(job.stage) : 'Ready when you are'}</h3>${job ? `<span class="badge">${escape(job.status.replaceAll('_',' '))}</span>` : ''}</div>${job ? `<progress max="100" value="${job.progress}" aria-label="Overall render workflow progress"></progress>` : ''}<p>${ready ? 'Your scenes are assembled. Preview the result or download your film.' : job?.error ? escape(job.error) : job ? 'Progress reflects completed workflow stages, not a GPU time estimate.' : 'New AI footage requires a connected video provider. Imported clips can be assembled locally.'}</p>${job?.cancelWarning ? `<p>${escape(job.cancelWarning)}</p>` : ''}<div class="button-row">${ready ? `<a class="export-link" href="/api/jobs/${job.id}/download">${icon('down')}Download MP4</a><a class="small" href="/api/jobs/${job.id}/captions">Captions .srt</a>` : job?.status === 'failed' ? `<button class="small" data-action="resume" data-id="${job.id}">Resume saved render</button>` : job && ['queued','running'].includes(job.status) ? `<button class="quiet small" data-action="cancel" data-id="${job.id}">Cancel render</button>` : ''}</div></div>`;
}
function renderLibrary() {
  const complete = jobs.filter(job => job.status === 'completed');
  shell(`<div class="heading"><div><h1>My videos</h1><p>Your rendered films, ready to watch and download.</p></div><span class="badge">${complete.length} films</span></div>${complete.length ? `<div class="gallery">${complete.map(job => `<article class="card"><video controls playsinline preload="metadata" src="/api/jobs/${job.id}/download?inline" aria-label="${escape(job.project.title)}"></video><div class="card-body"><h2>${escape(job.project.title)}</h2><p class="meta">${job.duration.toFixed(1)} seconds · ${escape(job.project.aspectRatio)} · ${escape(job.project.resolution)}</p><div class="button-row"><a class="export-link" href="/api/jobs/${job.id}/download">${icon('down')}MP4</a><button class="quiet small" data-project="${job.projectId}">Open project</button></div></div></article>`).join('')}</div>` : `<div class="empty-page"><span class="play-emblem">${icon('film')}</span><h2>No finished videos yet</h2><p class="muted">Your completed renders will be saved here.</p><button class="primary" data-view="studio">Open video studio${icon('arrow')}</button></div>`}`);
}
function renderSettings() {
  shell(`<div class="heading"><div><h1>Engine settings</h1><p>Connect the services that turn your scenes into video.</p></div></div><div class="settings"><section class="card"><div class="card-head"><h2>Video generation</h2><span class="badge ${config.providerReady ? 'ready' : ''}">${config.providerReady ? (config.providerKind === 'local' ? 'GPU detected' : 'Key configured') : 'Needs setup'}</span></div><div class="card-body">${config.providerKind === 'local' ? `<h3>Wan 2.2 on your GPU</h3><p>Generate footage using model weights stored on your own computer or GPU server. No fal account, API credits, or cloud inference service is used.</p><p>${escape(config.providerReason || 'Connect the GPU worker to begin.')}</p><p>Run the included GPU Compose setup on your NVIDIA machine. The private <code>SELF_HOSTED_TOKEN</code> is generated by you to protect your own service; it is not a paid API key.</p><p>This profile generates 5-second scenes at up to 704-line resolution. A 1080p export is resized from that footage. Generated scenes are silent; you can add narration or import clips with sound.</p>` : `<h3>Wan 2.5 via fal</h3><p>Cloud video generation is explicitly selected. Set <code>FAL_KEY</code> on the server and provide provider credits. To use your own GPU instead, set <code>VIDEO_PROVIDER=local</code> and restart Toon.</p><a href="https://fal.ai/dashboard/keys" target="_blank" rel="noreferrer">Manage fal API keys ↗</a>`}</div></section><section class="card timeline"><div class="card-head"><h2>Video assembly</h2><span class="badge ${config.mediaReady ? 'ready' : ''}">${config.mediaReady ? 'Available' : 'Needs setup'}</span></div><div class="card-body"><p>FFmpeg joins your scenes, fits the chosen format, controls audio, adds captions, and produces a real H.264 MP4. Docker includes FFmpeg; a direct installation needs <code>ffmpeg</code> and <code>ffprobe</code> in PATH.</p></div></section><section class="card timeline"><div class="card-head"><h2>AI script writer</h2><span class="badge ${config.plannerReady ? 'ready' : ''}">${config.plannerReady ? 'Configured' : 'Optional'}</span></div><div class="card-body"><p>Connect a local Ollama model to write multi-scene scripts from one idea. Set <code>OLLAMA_URL</code> and <code>OLLAMA_MODEL</code> on your server. Without it, you can write scenes yourself or split paragraphs.</p></div></section><section class="card timeline"><div class="card-head"><h2>Studio access</h2></div><div class="card-body"><p>This version is a private, single-owner studio. Use a studio password and HTTPS for remote access. Projects and generated media are saved on the engine server.</p><button class="quiet small" data-action="logout">Sign out</button></div></section></div>`);
}
function render() { view === 'studio' ? studio() : view === 'library' ? renderLibrary() : renderSettings(); }
function modal(title, content, actionLabel, action) {
  const dialog = $('#dialog');
  dialog.innerHTML = `<h2>${escape(title)}</h2>${content}<div class="button-row"><button data-close-dialog>Cancel</button><button class="primary" id="dialog-confirm">${escape(actionLabel)}</button></div>`;
  dialog.showModal();
  $('[data-close-dialog]').onclick = () => dialog.close();
  $('#dialog-confirm').onclick = () => { dialog.close(); attempt(action); };
}
async function save() {
  if (busy) throw new Error('Wait for the current action to finish.');
  const saved = await api(project.id ? `/projects/${project.id}` : '/projects', { method: project.id ? 'PUT' : 'POST', body: JSON.stringify(project) });
  project = saved; projects = await api('/projects'); dirty = false;
  return saved;
}
async function openProject(id) {
  const open = async () => { project = await api(`/projects/${id}`); dirty = false; view = 'studio'; renderKey = null; render(); };
  if (dirty) modal('Leave unsaved changes?', '<p>Your saved project stays available. Changes you have not saved will be discarded.</p>', 'Discard changes', open);
  else await open();
}
function newProject() {
  const create = () => { project = blank(); dirty = false; view = 'studio'; renderKey = null; render(); };
  dirty ? modal('Start a new film?', '<p>Save your current project first if you want to keep its unsaved changes.</p>', 'Discard and start', create) : create();
}
async function upload(kind, index) {
  const input = document.createElement('input'); input.type = 'file';
  input.accept = kind === 'video' ? 'video/mp4' : kind === 'audio' ? '.mp3,.wav' : 'image/png,image/jpeg,image/webp';
  input.onchange = () => attempt(async () => {
    const file = input.files[0]; if (!file) return;
    if (file.size > (kind === 'video' ? 100 : kind === 'audio' ? 20 : 10) * 1024 * 1024) throw new Error('The selected file exceeds the upload size limit.');
    toast('Uploading and checking your media…');
    const asset = await api('/assets', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
    if (asset.kind !== kind) throw new Error(`This file is not a valid ${kind}.`);
    if (kind === 'audio') project.narrationAsset = asset.id;
    else if (kind === 'video') { project.scenes[index].clipAsset = asset.id; if (!project.scenes[index].prompt) project.scenes[index].prompt = 'Imported video clip'; }
    else if (index != null) project.scenes[index].referenceAsset = asset.id;
    else project.referenceAsset = asset.id;
    markDirty(); render(); toast('Media attached.');
  }); input.click();
}
async function generate() {
  await save(); render();
  const generatedScenes = project.scenes.filter(item => !item.clipAsset).length;
  if (!config.mediaReady) throw new Error('Install FFmpeg before rendering. See Engine settings.');
  if (generatedScenes && !config.providerReady) throw new Error('Connect your video provider in Engine settings, or import a clip for each scene.');
  modal('Render this film?', `<p><strong>${escape(project.title)}</strong><br>${project.scenes.length} scenes · ${totalSeconds()} seconds · ${escape(project.resolution)}</p><p>${generatedScenes ? (config.providerKind === 'local' ? `${generatedScenes} scenes will be generated on your own GPU service. This uses your hardware and electricity, with no fal credits. Five-second scenes only; 1080p export is an upscale.` : `${generatedScenes} scenes will be sent to fal for paid video generation. Your prompts and any reference images are shared with the provider. Charges depend on your provider account and selected output.`) : 'This render uses your imported clips. No paid AI generation request is needed.'}</p>`, generatedScenes ? (config.providerKind === 'local' ? 'Generate on my GPU' : 'Use credits & generate') : 'Assemble video', async () => {
    busy = true; renderKey ??= crypto.randomUUID();
    try {
      const job = await api(`/projects/${project.id}/generate`, { method: 'POST', headers: { 'Idempotency-Key': renderKey }, body: JSON.stringify({ confirmProviderUsage: true }) });
      renderKey = null; jobs = [job, ...jobs.filter(j => j.id !== job.id)]; toast('Render queued. You can keep this tab open or return later.');
    } finally { busy = false; render(); }
  });
}
document.addEventListener('input', event => {
  const node = event.target;
  if (node.dataset.field) { project[node.dataset.field] = node.type === 'checkbox' ? node.checked : node.value; markDirty(); }
  if (node.dataset.sceneField) { project.scenes[Number(node.dataset.index)][node.dataset.sceneField] = ['duration', 'seed'].includes(node.dataset.sceneField) ? Number(node.value) : node.value; markDirty(); if ($('#timeline-meta')) $('#timeline-meta').textContent = `${project.scenes.length} scenes · ${totalSeconds()}s`; }
});
document.addEventListener('click', event => attempt(async () => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.view) { view = button.dataset.view; render(); return; }
  if (button.dataset.project) { await openProject(button.dataset.project); return; }
  const index = Number(button.dataset.index), action = button.dataset.sceneAction;
  if (action) {
    if (action === 'clip' || action === 'reference') { await upload(action === 'clip' ? 'video' : 'image', index); return; }
    if (action === 'delete') { modal('Remove this scene?', '<p>This removes the scene from the current sequence. Previously rendered videos are kept.</p>', 'Remove scene', () => { project.scenes.splice(index,1); markDirty(); render(); }); return; }
    if (action === 'up' || action === 'down') { const next = index + (action === 'up' ? -1 : 1); [project.scenes[index],project.scenes[next]] = [project.scenes[next],project.scenes[index]]; }
    if (action === 'clear-reference') project.scenes[index].referenceAsset = null;
    if (action === 'clear-clip') project.scenes[index].clipAsset = null;
    markDirty(); render(); return;
  }
  switch (button.dataset.action) {
    case 'new': newProject(); break;
    case 'save': await save(); render(); toast('Project saved.'); break;
    case 'add-scene': if (project.scenes.length < 8) { project.scenes.push(scene()); markDirty(); render(); } break;
    case 'save-character': {
      if (!project.character.trim()) throw new Error('Write a character description first.');
      modal('Save reusable character', '<div class="field"><label for="character-name">Character name</label><input id="character-name" maxlength="80" placeholder="Character name"></div><p>The description and current reference image will be available in every project.</p>', 'Save character', async () => {
        await api('/characters', {method:'POST',body:JSON.stringify({name:$('#character-name').value,description:project.character,referenceAsset:project.referenceAsset})});
        characters = await api('/characters'); render(); toast('Character saved.');
      }); break;
    }
    case 'load-character': {
      modal('Choose a character', `<div class="field"><label for="character-choice">Saved character</label><select id="character-choice">${characters.map(c => `<option value="${c.id}">${escape(c.name)}</option>`).join('')}</select></div><p>This replaces the current character description and project reference image.</p>`, 'Use character', () => {
        const c = characters.find(c => c.id === $('#character-choice').value);
        if(c){project.character=c.description;project.referenceAsset=c.referenceAsset;markDirty();render();}
      }); break;
    }
    case 'reference': await upload('image'); break;
    case 'narration': await upload('audio'); break;
    case 'clear-reference': project.referenceAsset = null; markDirty(); render(); break;
    case 'clear-narration': project.narrationAsset = null; markDirty(); render(); break;
    case 'split': case 'plan': {
      const mode = button.dataset.action === 'plan' ? 'ai' : 'paragraphs';
      const build = async () => {
        button.disabled = true; toast(mode === 'ai' ? 'Writing your storyboard…' : 'Preparing scenes…');
        try { const result = await api('/storyboard', { method:'POST', body:JSON.stringify({ idea:project.idea, mode }) }); project.scenes = result.scenes; markDirty(); render(); toast(result.method === 'ollama' ? 'AI storyboard ready. Review each scene before generating.' : 'Paragraphs split into scenes.'); }
        finally { button.disabled = false; }
      };
      if (project.scenes.some(s => s.prompt.trim() || s.clipAsset)) modal('Replace current scenes?', '<p>The new storyboard will replace your current scene sequence. Previously rendered videos are kept.</p>', 'Replace scenes', build);
      else await build(); break;
    }
    case 'generate': await generate(); break;
    case 'cancel': await api(`/jobs/${button.dataset.id}/cancel`, { method:'POST' }); jobs = await api('/jobs'); updateRender(); break;
    case 'resume': await api(`/jobs/${button.dataset.id}/resume`, { method:'POST' }); jobs = await api('/jobs'); updateRender(); break;
    case 'logout': await api('/logout', { method:'POST' }); await boot(); break;
  }
}));
function showLogin() {
  clearInterval(poll);
  $('#app').innerHTML = `<div class="login"><form class="card" id="login-form">${brand()}<h1>Open your studio</h1><p>Enter the studio password to access your projects and video engine.</p><div class="field"><label for="password">Studio password</label><input id="password" type="password" autocomplete="current-password" required></div><button class="primary" type="submit">Sign in${icon('arrow')}</button></form></div>`;
  $('#login-form').onsubmit = event => { event.preventDefault(); attempt(async () => { await api('/login', { method:'POST', body:JSON.stringify({ password:$('#password').value }) }); await boot(); }); };
}
async function boot() {
  clearInterval(poll);
  const health = await api('/health');
  if (!health.authenticated) { showLogin(); return; }
  [config, projects, jobs, characters] = await Promise.all([api('/config'), api('/projects'), api('/jobs'), api('/characters')]);
  if (!project.id && projects.length) project = projects[0];
  render();
  poll = setInterval(async () => { try { jobs = await api('/jobs'); updateRender(); } catch { /* Errors are reported by actions; keep unsaved edits intact. */ } }, 3000);
}
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
attempt(boot);
