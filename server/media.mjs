import { spawn, spawnSync } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dimensions, AppError } from './domain.mjs';

export function ffmpegAvailable() { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0; }
export function command(binary, args, { signal, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], signal, cwd });
    let output = '', error = '';
    const timeout = setTimeout(() => process.kill('SIGKILL'), 10 * 60 * 1000);
    process.stdout.on('data', chunk => { output = (output + chunk).slice(-1024 * 1024); });
    process.stderr.on('data', chunk => { error = (error + chunk).slice(-4000); });
    process.on('error', failure => { clearTimeout(timeout); reject(failure); });
    process.on('close', code => { clearTimeout(timeout); code === 0 ? resolve(output) : reject(new AppError(`${binary} could not process this media. ${error.slice(-350)}`, 422, 'media_processing_failed')); });
  });
}
export async function inspect(path) {
  const result = await command('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', path]);
  return JSON.parse(result);
}
export async function validateMedia(path, kind) {
  const info = await inspect(path);
  const video = info.streams.find(s => s.codec_type === 'video');
  const audio = info.streams.find(s => s.codec_type === 'audio');
  if (kind === 'image' && (!video || video.width < 360 || video.height < 360 || video.width > 2000 || video.height > 2000)) throw new AppError('Reference images must be between 360 and 2000 pixels on each side.');
  if (kind === 'video' && (!video || video.width > 4096 || video.height > 4096 || !(Number(info.format.duration) > 0) || Number(info.format.duration) > 90)) throw new AppError('Upload a valid video up to 90 seconds and 4096 pixels.');
  if (kind === 'audio' && (!audio || !(Number(info.format.duration) > 0) || Number(info.format.duration) > 120)) throw new AppError('Upload a narration recording up to 120 seconds.');
  return info;
}
export async function referenceData(path, aspect, workDir) {
  const output = join(workDir, 'reference.png');
  const [w, h] = dimensions(aspect, '720p');
  await command('ffmpeg', ['-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', path,
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,format=rgb24`, '-frames:v', '1', '-threads', '1', output]);
  return `data:image/png;base64,${(await readFile(output)).toString('base64')}`;
}
export async function normalizeClip(input, output, project, scene, signal) {
  const [w, h] = dimensions(project.aspectRatio, project.resolution);
  let filters = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=${scene.duration}`;
  if (project.captions && scene.caption) {
    const captionPath = output + '.txt';
    await writeFile(captionPath, scene.caption.replace(/(.{1,36})(\s+|$)/g, '$1\n').trim());
    // Only generated filesystem paths enter the filter string; text is never an expression.
    filters += `,drawtext=textfile='${captionPath.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''")}':expansion=none:fontcolor=white:fontsize=${Math.round(w / 30)}:box=1:boxcolor=black@0.65:boxborderw=12:x=(w-text_w)/2:y=h-text_h-h/12`;
  }
  const args = ['-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', input];
  if (project.audioMode === 'source') {
    const hasAudio = (await inspect(input)).streams.some(s => s.codec_type === 'audio');
    if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0', '-af', 'apad', '-c:a', 'aac', '-ar', '48000', '-ac', '2');
  } else args.push('-map', '0:v:0', '-an');
  args.push('-vf', filters, '-t', String(scene.duration), '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-threads', '2', '-movflags', '+faststart', output);
  await command('ffmpeg', args, { signal });
}
export function subtitleText(project) {
  const stamp = seconds => new Date(seconds * 1000).toISOString().slice(11, 23).replace('.', ',');
  let offset = 0, number = 0;
  return project.scenes.map(scene => {
    const start = offset; offset += scene.duration;
    return scene.caption ? `${++number}\n${stamp(start)} --> ${stamp(offset)}\n${scene.caption.replaceAll('-->', '→')}\n` : '';
  }).filter(Boolean).join('\n');
}
export async function assemble(clips, directory, project, narrationPath, signal) {
  await mkdir(directory, { recursive: true });
  const list = clips.map(path => `file '${path.replaceAll("'", "'\\''")}'`).join('\n');
  const listPath = join(directory, 'concat.txt');
  await writeFile(listPath, list);
  const output = join(directory, 'final.mp4');
  const args = ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe', '-i', listPath];
  if (narrationPath) args.push('-protocol_whitelist', 'file,pipe', '-i', narrationPath, '-map', '0:v:0', '-map', '1:a:0', '-af', 'apad', '-c:a', 'aac', '-shortest');
  else if (project.audioMode === 'source') args.push('-map', '0:v:0', '-map', '0:a:0', '-c:a', 'copy');
  else args.push('-map', '0:v:0', '-an');
  args.push('-c:v', 'copy', '-movflags', '+faststart', output);
  await command('ffmpeg', args, { signal });
  await writeFile(join(directory, 'captions.srt'), subtitleText(project));
  const info = await inspect(output);
  if (!narrationPath && project.audioMode === 'silent' && info.streams.some(s => s.codec_type === 'audio')) throw new Error('Silent export unexpectedly contains audio.');
  return { output, duration: Number(info.format.duration), size: Number(info.format.size) };
}
