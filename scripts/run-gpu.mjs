import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const python = process.env.GPU_PYTHON || (existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3');
const probe = process.argv.includes('--probe');
const child = spawn(python, ['-m', probe ? 'gpu_service.runner' : 'gpu_service.service', ...(probe ? ['--probe'] : [])], { stdio: 'inherit', env: process.env });
child.on('error', () => { console.error('Python could not start. Install the GPU worker environment first.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
