import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message); this.status = status; this.code = code;
  }
}
export const styles = {
  cartoon: 'Original 3D animated family cartoon, expressive characters, soft cinematic lighting, detailed environments.',
  illustration: 'Original hand-drawn 2D animation, clear silhouettes, expressive movement, painted backgrounds.',
  cinematic: 'Cinematic live-action visual style, natural lighting, carefully composed shots, fluid motion.',
  clay: 'Original stop-motion clay animation, handmade textures, miniature sets, tactile materials.',
};
export function text(value, name, max = 1000, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new AppError(`${name} must be ${required ? 'non-empty text, ' : 'text, '}up to ${max} characters.`);
  }
  return value.trim();
}
function choice(value, values, name) {
  if (!values.includes(value)) throw new AppError(`Invalid ${name}.`);
  return value;
}
function asset(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new AppError('Invalid asset ID.');
  return value;
}
export function validateProject(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > 8) {
    throw new AppError('Add between one and eight scenes.');
  }
  const project = {
    title: text(input.title, 'Title', 100, true),
    idea: text(input.idea ?? '', 'Story idea', 6000),
    character: text(input.character ?? '', 'Character description', 400),
    referenceAsset: asset(input.referenceAsset),
    narrationAsset: asset(input.narrationAsset),
    style: choice(input.style ?? 'cartoon', Object.keys(styles), 'style'),
    aspectRatio: choice(input.aspectRatio ?? '16:9', ['16:9', '9:16', '1:1'], 'aspect ratio'),
    resolution: choice(input.resolution ?? '720p', ['480p', '720p', '1080p'], 'resolution'),
    captions: input.captions === true,
    audioMode: choice(input.audioMode ?? 'silent', ['silent', 'source'], 'audio mode'),
    scenes: input.scenes.map((scene) => ({
      id: randomUUID(),
      prompt: text(scene.prompt, 'Scene prompt', 850, true),
      caption: text(scene.caption ?? '', 'Caption', 180),
      duration: choice(Number(scene.duration ?? 5), [5, 10], 'scene duration'),
      referenceAsset: asset(scene.referenceAsset),
      clipAsset: asset(scene.clipAsset),
      seed: scene.seed == null || scene.seed === '' ? 42 : Number(scene.seed),
    })),
  };
  for (const scene of project.scenes) {
    if (!Number.isInteger(scene.seed) || scene.seed < 0 || scene.seed > 2147483647) throw new AppError('Seed must be an integer from 0 to 2147483647.');
    if (buildPrompt(project, scene).length > 1500) throw new AppError('Scene and character description together exceed the video model prompt limit.');
  }
  return project;
}
export function buildPrompt(project, scene) {
  return [styles[project.style], project.character ? `Keep this character appearance consistent: ${project.character}` : '', scene.prompt,
    'One continuous moving shot. No subtitles or written text.', project.audioMode === 'silent' ? 'No music or singing.' : 'Natural scene audio.'].filter(Boolean).join('\n');
}
export function providerInput(project, scene, imageData) {
  const input = {
    prompt: buildPrompt(project, scene), duration: String(scene.duration), resolution: project.resolution,
    seed: scene.seed, enable_prompt_expansion: false, enable_safety_checker: true,
    negative_prompt: project.audioMode === 'silent' ? 'music, singing, text, subtitles, watermarks' : 'text, subtitles, watermarks',
  };
  if (imageData) input.image_url = imageData;
  else input.aspect_ratio = project.aspectRatio;
  return input;
}
export function dimensions(aspect, resolution) {
  const short = { '480p': 480, '720p': 720, '1080p': 1080 }[resolution];
  const long = Math.round(short * 16 / 9 / 2) * 2;
  return aspect === '9:16' ? [short, long] : aspect === '1:1' ? [short, short] : [long, short];
}
export function splitStoryboard(idea) {
  const paragraphs = text(idea, 'Story idea', 6000, true).split(/\n\s*\n/).filter(Boolean);
  if (paragraphs.length > 8) throw new AppError('Use at most eight paragraphs, one per scene.');
  return paragraphs.map(prompt => ({ prompt: text(prompt, 'Scene paragraph', 850, true), duration: 5, caption: '', seed: 42 }));
}
export const activeStatuses = ['queued', 'running'];
