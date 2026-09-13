import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './domain.mjs';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'toon.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS characters(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs(project_id) WHERE status IN ('queued','running');`);
  }
  projects() { return this.db.prepare('SELECT id,data,updated FROM projects ORDER BY updated DESC').all().map(row => ({ ...JSON.parse(row.data), id: row.id, updated: row.updated })); }
  project(id) { const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id); if (!row) throw new AppError('Project not found.', 404); return { ...JSON.parse(row.data), id, updated: row.updated }; }
  saveProject(data, id = randomUUID()) {
    const updated = new Date().toISOString();
    this.db.prepare('INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated=excluded.updated').run(id, JSON.stringify(data), updated);
    return this.project(id);
  }
  jobs(projectId) {
    const rows = projectId ? this.db.prepare('SELECT data FROM jobs WHERE project_id=? ORDER BY created DESC').all(projectId) : this.db.prepare('SELECT data FROM jobs ORDER BY created DESC').all();
    return rows.map(row => JSON.parse(row.data));
  }
  job(id) { const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id); if (!row) throw new AppError('Render not found.', 404); return JSON.parse(row.data); }
  saveJob(job) {
    job.updated = new Date().toISOString();
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(job.id, job.projectId, job.status, JSON.stringify(job), job.created);
    return job;
  }
  addJob(project, key, providerKind = 'fal', providerIdentity = providerKind) {
    const previous = this.jobs(project.id).find(job => job.idempotencyKey === key);
    if (previous) return previous;
    if (this.jobs(project.id).some(job => ['queued', 'running'].includes(job.status))) throw new AppError('This project already has an active render.', 409);
    const job = { id: randomUUID(), projectId: project.id, project: structuredClone(project), idempotencyKey: key, providerKind, providerIdentity,
      status: 'queued', stage: 'Waiting to start', progress: 0, cancelRequested: false,
      scenes: project.scenes.map(() => ({ status: 'pending' })), created: new Date().toISOString() };
    return this.saveJob(job);
  }
  saveAsset(data) { const id = randomUUID(); this.db.prepare('INSERT INTO assets VALUES(?,?)').run(id, JSON.stringify({ ...data, id })); return { ...data, id }; }
  characters() { return this.db.prepare('SELECT data FROM characters ORDER BY rowid DESC').all().map(row => JSON.parse(row.data)); }
  saveCharacter(data) { const character = { ...data, id: randomUUID() }; this.db.prepare('INSERT INTO characters VALUES(?,?)').run(character.id, JSON.stringify(character)); return character; }
  asset(id) { const row = this.db.prepare('SELECT data FROM assets WHERE id=?').get(id); if (!row) throw new AppError('Asset not found.', 404); return JSON.parse(row.data); }
  close() { this.db.close(); }
}
