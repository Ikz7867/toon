import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { referenceData, normalizeClip, assemble, validateMedia } from './media.mjs';
import { AppError } from './domain.mjs';

export class Engine {
  constructor(store, provider, directory, options = {}) {
    this.store = store; this.provider = provider; this.directory = directory;
    this.pollInterval = options.pollInterval ?? 5000;
    this.providerTimeout = options.providerTimeout ?? 1800000;
    this.stopped = false; this.active = null; this.timer = null;
  }
  recover() {
    for (const job of this.store.jobs()) {
      if (job.status !== 'running') continue;
      // A submission can be accepted remotely before its response is persisted.
      // Never blindly repeat that paid request after a process crash.
      if (job.scenes.some(scene => scene.status === 'submitting' && !scene.handle) && (job.providerKind ?? 'fal') !== 'local') {
        job.status = 'needs_review'; job.error = 'Submission was interrupted. Check the fal queue before starting another render; the provider may already have charged for this scene.';
      } else { job.status = 'queued'; job.stage = 'Resuming saved render'; }
      this.store.saveJob(job);
    }
  }
  start() { this.recover(); this.timer = setInterval(() => this.tick(), 1000); this.timer.unref(); this.tick(); }
  async stop() { this.stopped = true; clearInterval(this.timer); this.controller?.abort(); if (this.active) await this.active; }
  async tick() {
    if (this.active || this.stopped) return;
    const job = this.store.jobs().reverse().find(job => job.status === 'queued');
    if (!job) return;
    this.active = this.run(job).finally(() => { this.active = null; });
    await this.active;
  }
  async checkCancellation(job) {
    if (this.stopped) throw new AppError('Server stopping. Render will resume on restart.', 503, 'stopping');
    if (this.store.job(job.id).cancelRequested) {
      for (const scene of job.scenes) {
        if (scene.handle && !['done', 'downloaded'].includes(scene.status)) {
          try { await this.provider.cancel(scene.handle); }
          catch { job.cancelWarning = 'Remote cancellation could not be confirmed. Check the provider queue; compute may still be billed.'; }
        }
      }
      throw new AppError('Render cancelled.', 409, 'cancelled');
    }
  }
  save(job) {
    job.cancelRequested = this.store.job(job.id).cancelRequested;
    this.store.saveJob(job);
  }
  async run(job) {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const directory = join(this.directory, 'renders', job.id);
    try {
      if (job.project.scenes.some(scene => !scene.clipAsset) && (job.providerIdentity ?? job.providerKind ?? 'fal') !== (this.provider.identity ?? this.provider.kind ?? 'fal')) throw new AppError('This render belongs to a different video backend. Restore its original provider configuration before resuming.', 409);
      await mkdir(directory, { recursive: true });
      job.status = 'running'; this.save(job);
      for (let index = 0; index < job.scenes.length; index++) {
        await this.checkCancellation(job);
        const state = job.scenes[index], scene = job.project.scenes[index];
        const output = join(directory, `scene-${index}.mp4`);
        if (state.status === 'done' && await stat(output).catch(() => null)) continue;
        const sceneDirectory = join(directory, `work-${index}`);
        await mkdir(sceneDirectory, { recursive: true });
        job.stage = `Scene ${index + 1} of ${job.scenes.length}`;
        job.progress = Math.floor(index / job.scenes.length * 85); this.save(job);
        let source;
        if (scene.clipAsset) {
          source = join(this.directory, 'uploads', this.store.asset(scene.clipAsset).file);
        } else {
          source = join(sceneDirectory, 'source.mp4');
          if (state.status !== 'downloaded') {
            if (!state.handle) {
              const referenceId = scene.referenceAsset || job.project.referenceAsset;
              const image = referenceId ? await referenceData(join(this.directory, 'uploads', this.store.asset(referenceId).file), job.project.aspectRatio, sceneDirectory) : null;
              state.status = 'submitting'; this.save(job);
              state.handle = await this.provider.submit(job.project, scene, image, `${job.id}:${index}`);
              state.status = 'submitted'; this.save(job);
            }
            const pollStarted = Date.now();
            while (true) {
              await this.checkCancellation(job);
              if (Date.now() - pollStarted > this.providerTimeout) throw new AppError('Provider is taking longer than expected. Resume to keep checking the same request; it will not be submitted again.', 504);
              const status = await this.provider.status(state.handle);
              if (status.status === 'COMPLETED') break;
              if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) throw new AppError(`Provider reported ${String(status.status).slice(0, 60)}.`, 502);
              state.status = status.status === 'IN_QUEUE' ? 'queued' : 'generating';
              job.stage = `Scene ${index + 1}: ${state.status === 'queued' ? 'waiting for GPU' : 'generating motion'}`;
              this.save(job);
              await delay(this.pollInterval, undefined, { signal });
            }
            const url = await this.provider.result(state.handle);
            job.stage = `Downloading scene ${index + 1}`; this.save(job);
            await this.provider.download(url, source);
            await validateMedia(source, 'video');
            state.status = 'downloaded'; this.save(job);
          }
        }
        await this.checkCancellation(job);
        job.stage = `Preparing scene ${index + 1}`; this.save(job);
        await normalizeClip(source, output, job.project, scene, signal);
        state.status = 'done'; state.file = `scene-${index}.mp4`; this.save(job);
      }
      await this.checkCancellation(job);
      job.stage = 'Assembling final MP4'; job.progress = 90; this.save(job);
      const narration = job.project.narrationAsset ? join(this.directory, 'uploads', this.store.asset(job.project.narrationAsset).file) : null;
      const result = await assemble(job.scenes.map(scene => join(directory, scene.file)), directory, job.project, narration, signal);
      await this.checkCancellation(job);
      job.status = 'completed'; job.stage = 'Ready to download'; job.progress = 100;
      job.output = 'final.mp4'; job.duration = result.duration; job.bytes = result.size; job.error = null;
      this.save(job);
    } catch (error) {
      if (this.stopped) { job.status = 'running'; this.save(job); return; }
      job.status = error.code === 'cancelled' ? 'cancelled' : !this.provider.idempotentSubmission && job.scenes.some(scene => scene.status === 'submitting' && !scene.handle) ? 'needs_review' : 'failed';
      job.error = job.status === 'needs_review' ? 'Provider submission was not confirmed. Check the fal queue before starting another render to avoid duplicate charges.' : error.message;
      job.stage = job.status === 'cancelled' ? 'Cancelled' : 'Needs attention'; this.save(job);
    }
  }
}
