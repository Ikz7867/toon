"""Authenticated, durable single-GPU queue using Python's standard library."""
import base64
import hashlib
import hmac
import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RUNNER = Path(__file__).with_name('runner.py')


class RequestError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def validate(body):
    if not isinstance(body, dict):
        raise RequestError('Expected a JSON object.')
    def text(name, limit, required=False):
        value = body.get(name, '')
        if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
            raise RequestError(f'Invalid {name}.')
        return value.strip()
    prompt = text('prompt', 1500, True)
    negative = text('negative_prompt', 500)
    if type(body.get('duration')) is not int or body['duration'] != 5:
        raise RequestError('This Wan profile generates 5-second scenes only.')
    if body.get('aspect_ratio') not in ['16:9', '9:16', '1:1'] or body.get('resolution') not in ['480p', '720p', '1080p']:
        raise RequestError('Invalid output format.')
    if type(body.get('seed')) is not int or not 0 <= body['seed'] <= 2147483647:
        raise RequestError('Invalid seed.')
    image_bytes = None
    if body.get('image') is not None:
        data = body['image']
        prefix = 'data:image/png;base64,'
        if not isinstance(data, str) or not data.startswith(prefix):
            raise RequestError('Reference image must be a PNG data URI, never a remote URL.')
        try:
            image_bytes = base64.b64decode(data[len(prefix):], validate=True)
        except (ValueError, TypeError):
            raise RequestError('Invalid base64 reference image.')
        if len(image_bytes) > 10 * 1024 * 1024 or not image_bytes.startswith(b'\x89PNG\r\n\x1a\n'):
            raise RequestError('Invalid or oversized PNG reference.')
    return {'prompt': prompt, 'negative_prompt': negative, 'duration': 5, 'aspect_ratio': body['aspect_ratio'], 'resolution': body['resolution'], 'seed': body['seed']}, image_bytes


class Queue:
    def __init__(self, root, probe=None, command_factory=None):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.root / 'queue.sqlite', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created REAL NOT NULL, cancel INTEGER NOT NULL DEFAULT 0)')
        # Local inference can restart safely under the same request ID after a crash.
        self.db.execute("UPDATE requests SET status=CASE WHEN cancel=1 THEN 'CANCELLED' ELSE 'IN_QUEUE' END WHERE status='IN_PROGRESS'")
        self.db.commit()
        self.probe_fn = probe or self._probe
        self.command_factory = command_factory or (lambda request, output: [sys.executable, str(RUNNER), '--request', str(request), '--output', str(output)])
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.thread = None
        self.process = None
        self.health_cache = None
        self.health_at = 0

    def _probe(self):
        try:
            result = subprocess.run([sys.executable, str(RUNNER), '--probe'], capture_output=True, text=True, timeout=25)
            return json.loads(result.stdout.strip().splitlines()[-1])
        except Exception:
            return {'ready': False, 'reason': 'GPU preflight did not complete. Check the worker dependencies and logs.'}

    def health(self):
        # Serialise probes; torch import can take several seconds on first use.
        with self.lock:
            if self.health_cache is None or time.monotonic() - self.health_at > 15:
                self.health_cache = self.probe_fn()
                self.health_at = time.monotonic()
            return dict(self.health_cache)

    def submit(self, body, request_key):
        if not isinstance(request_key, str) or not 1 <= len(request_key) <= 120 or not re.fullmatch(r'[A-Za-z0-9:_-]+', request_key):
            raise RequestError('A valid Idempotency-Key is required.')
        spec, image = validate(body)
        fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        with self.lock:
            existing = self.db.execute('SELECT * FROM requests WHERE request_key=?', (request_key,)).fetchone()
            if existing:
                if existing['fingerprint'] != fingerprint:
                    raise RequestError('Idempotency key was already used with different input.', 409)
                return dict(existing)
            health = self.health()
            if not health.get('ready'):
                raise RequestError(health.get('reason', 'GPU is not ready.'), 503)
            if self.db.execute("SELECT COUNT(*) FROM requests WHERE status IN ('IN_QUEUE','IN_PROGRESS')").fetchone()[0] >= 32:
                raise RequestError('GPU queue is full.', 429)
            request_id = str(uuid.uuid4())
            folder = self.root / request_id
            folder.mkdir()
            if image:
                image_path = folder / 'reference.png'
                image_path.write_bytes(image)
                spec['image_path'] = str(image_path)
            (folder / 'request.json').write_text(json.dumps(spec))
            self.db.execute('INSERT INTO requests(id,request_key,fingerprint,status,created) VALUES(?,?,?,?,?)', (request_id, request_key, fingerprint, 'IN_QUEUE', time.time()))
            self.db.commit()
            self.wake.set()
            return self.get(request_id)

    def get(self, request_id):
        with self.lock:
            row = self.db.execute('SELECT * FROM requests WHERE id=?', (request_id,)).fetchone()
            if not row:
                raise RequestError('GPU request not found.', 404)
            return dict(row)

    def cancel(self, request_id):
        with self.lock:
            job = self.get(request_id)
            if job['status'] in ['COMPLETED', 'FAILED', 'CANCELLED']:
                return job
            self.db.execute("UPDATE requests SET cancel=1,status=CASE WHEN status='IN_QUEUE' THEN 'CANCELLED' ELSE status END WHERE id=?", (request_id,))
            self.db.commit()
            self.wake.set()
            return self.get(request_id)

    def start(self):
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def retry(self, request_id):
        with self.lock:
            job = self.get(request_id)
            if job['status'] != 'FAILED':
                raise RequestError('Only failed GPU requests can be retried.', 409)
            self.db.execute("UPDATE requests SET status='IN_QUEUE',error=NULL,cancel=0 WHERE id=?", (request_id,))
            self.db.commit()
            self.wake.set()
            return self.get(request_id)

    def _loop(self):
        while not self.stop_event.is_set():
            with self.lock:
                row = self.db.execute("SELECT * FROM requests WHERE status='IN_QUEUE' ORDER BY created LIMIT 1").fetchone()
                if row:
                    self.db.execute("UPDATE requests SET status='IN_PROGRESS' WHERE id=?", (row['id'],))
                    self.db.commit()
            if row:
                self.run(dict(row))
            else:
                self.wake.wait(0.5)
                self.wake.clear()

    def run(self, job):
        request_id = job['id']
        folder = self.root / request_id
        output = folder / 'output.mp4'
        status, error = 'FAILED', None
        try:
            output.unlink(missing_ok=True)
            with (folder / 'worker.log').open('w') as log:
                self.process = subprocess.Popen(self.command_factory(folder / 'request.json', output), stdout=log, stderr=log, start_new_session=True)
                deadline = time.monotonic() + int(os.environ.get('WAN_JOB_TIMEOUT_SECONDS', '7200'))
                while self.process.poll() is None:
                    if self.stop_event.is_set() or self.get(request_id)['cancel'] or time.monotonic() > deadline:
                        os.killpg(self.process.pid, signal.SIGTERM)
                        try:
                            self.process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            os.killpg(self.process.pid, signal.SIGKILL)
                            self.process.wait()
                        break
                    self.stop_event.wait(0.2)
                if self.get(request_id)['cancel']:
                    status, error = 'CANCELLED', 'GPU generation was cancelled.'
                elif self.stop_event.is_set():
                    status = 'IN_QUEUE'
                elif self.process.returncode == 0 and output.is_file():
                    # Check the actual media before exposing a completed request.
                    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output)], capture_output=True, text=True, timeout=30)
                    media = json.loads(probe.stdout)
                    if probe.returncode != 0 or not any(s.get('codec_type') == 'video' for s in media.get('streams', [])) or float(media.get('format', {}).get('duration', 0)) <= 0:
                        raise ValueError('Output is not a playable video.')
                    status = 'COMPLETED'
                else:
                    error = 'Local GPU inference failed or timed out. Check this request’s worker.log for missing weights, dependency errors, or GPU memory exhaustion.'
        except Exception as failure:
            error = f'Local inference could not complete ({type(failure).__name__}). Check worker.log.'
        finally:
            self.process = None
            with self.lock:
                # A cancellation that arrived while ffprobe ran still wins.
                if self.get(request_id)['cancel']:
                    status, error = 'CANCELLED', 'GPU generation was cancelled.'
                self.db.execute('UPDATE requests SET status=?,error=? WHERE id=?', (status, error, request_id))
                self.db.commit()

    def close(self):
        self.stop_event.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=45)
            if self.thread.is_alive():
                raise RuntimeError('GPU worker did not stop cleanly.')
        self.db.close()


def make_server(queue, token, host='127.0.0.1', port=8188):
    if len(token) < 32:
        raise ValueError('SELF_HOSTED_TOKEN must contain at least 32 characters. Generate it locally; it is not a paid API key.')

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Do not log prompts or authorization headers.

        def reply(self, status, data):
            payload = json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)

        def handle_request(self):
            try:
                if self.headers.get('Origin') or not hmac.compare_digest(self.headers.get('Authorization', '').encode(), ('Bearer ' + token).encode()):
                    raise RequestError('Unauthorized GPU service request.', 401)
                if self.path == '/health' and self.command == 'GET':
                    return self.reply(200, queue.health())
                if self.path == '/requests' and self.command == 'POST':
                    if self.headers.get('Transfer-Encoding') or not self.headers.get('Content-Length', '').isdigit():
                        raise RequestError('Content-Length is required.', 411)
                    length = int(self.headers['Content-Length'])
                    if length > 16 * 1024 * 1024:
                        raise RequestError('GPU request is too large.', 413)
                    self.connection.settimeout(30)
                    payload = self.rfile.read(length)
                    if len(payload) != length:
                        raise RequestError('Incomplete request body.')
                    try:
                        body = json.loads(payload)
                    except (ValueError, UnicodeError):
                        raise RequestError('Invalid JSON.')
                    job = queue.submit(body, self.headers.get('Idempotency-Key'))
                    return self.reply(202, {'request_id': job['id'], 'status': job['status']})
                match = re.fullmatch(r'/requests/([a-f0-9-]{36})(?:/(cancel|retry|result|video))?', self.path)
                if not match:
                    raise RequestError('Endpoint not found.', 404)
                request_id, action = match.groups()
                job = queue.get(request_id)
                if action == 'cancel' and self.command == 'POST':
                    job = queue.cancel(request_id)
                elif action == 'retry' and self.command == 'POST':
                    job = queue.retry(request_id)
                elif action in ['result', 'video'] and self.command == 'GET':
                    if job['status'] != 'COMPLETED':
                        raise RequestError('GPU result is not ready.', 409)
                    if action == 'video':
                        video = queue.root / request_id / 'output.mp4'
                        self.send_response(200)
                        self.send_header('Content-Type', 'video/mp4')
                        self.send_header('Content-Length', str(video.stat().st_size))
                        self.send_header('Cache-Control', 'no-store')
                        self.end_headers()
                        with video.open('rb') as source:
                            while chunk := source.read(65536):
                                self.wfile.write(chunk)
                        return
                elif action or self.command != 'GET':
                    raise RequestError('Method not allowed.', 405)
                return self.reply(200, {'request_id': job['id'], 'status': job['status'], 'error': job['error']})
            except RequestError as error:
                self.reply(error.status, {'error': str(error)})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self.reply(500, {'error': 'GPU service error. Check the worker logs.'})

        do_GET = handle_request
        do_POST = handle_request

    return ThreadingHTTPServer((host, port), Handler)


def main():
    queue = Queue(os.environ.get('GPU_DATA_DIR', './gpu-data'))
    server = make_server(queue, os.environ.get('SELF_HOSTED_TOKEN', ''), os.environ.get('GPU_HOST', '127.0.0.1'), int(os.environ.get('GPU_PORT', '8188')))
    queue.start()
    def stop(*_args):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        print(f'GPU queue listening on {server.server_address[0]}:{server.server_address[1]}', flush=True)
        server.serve_forever()
    finally:
        server.server_close()
        queue.close()


if __name__ == '__main__':
    main()
