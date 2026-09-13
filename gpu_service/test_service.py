import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

from gpu_service.runner import frame_shape
from gpu_service.service import Queue, RequestError, make_server, validate


def payload(**changes):
    return {'prompt': 'A blue robot walks through a park.', 'negative_prompt': '', 'duration': 5, 'aspect_ratio': '16:9', 'resolution': '720p', 'seed': 42, **changes}


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.queue = Queue(self.folder.name, probe=lambda: {'ready': True, 'reason': 'Test fixture only'})

    def tearDown(self):
        self.queue.close()
        self.folder.cleanup()

    def test_idempotency_and_input_conflict(self):
        first = self.queue.submit(payload(), 'job:0')
        self.assertEqual(first['id'], self.queue.submit(payload(), 'job:0')['id'])
        with self.assertRaises(RequestError):
            self.queue.submit(payload(prompt='Changed'), 'job:0')

    def test_constraints_and_remote_image_rejection(self):
        for invalid in [{'duration': 10}, {'duration': True}, {'image': 'https://127.0.0.1/private'}, {'image': 'data:image/png;base64,XXXX'}, {'seed': -1}, {'resolution': '4K'}]:
            with self.subTest(invalid=invalid), self.assertRaises(RequestError):
                validate(payload(**invalid))
        self.assertEqual(frame_shape('9:16', '1080p'), (704, 1280))
        self.assertEqual(frame_shape('16:9', '480p'), (832, 480))

    def test_unready_worker_never_creates_a_job(self):
        self.queue.probe_fn = lambda: {'ready': False, 'reason': 'No CUDA GPU'}
        with self.assertRaisesRegex(RequestError, 'No CUDA GPU'):
            self.queue.submit(payload(), 'job:0')
        self.assertEqual(self.queue.db.execute('SELECT COUNT(*) FROM requests').fetchone()[0], 0)

    def test_cancel_before_start_prevents_inference(self):
        job = self.queue.submit(payload(), 'job:0')
        self.queue.cancel(job['id'])
        self.assertEqual(self.queue.get(job['id'])['status'], 'CANCELLED')

    def test_restart_retains_request_id_and_does_not_duplicate(self):
        job = self.queue.submit(payload(), 'job:0')
        self.queue.db.execute("UPDATE requests SET status='IN_PROGRESS' WHERE id=?", (job['id'],))
        self.queue.db.commit()
        self.queue.close()
        self.queue = Queue(self.folder.name, probe=lambda: {'ready': True})
        self.assertEqual(self.queue.get(job['id'])['status'], 'IN_QUEUE')
        self.assertEqual(self.queue.submit(payload(), 'job:0')['id'], job['id'])

    def wait_status(self, request_id, expected):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            job = self.queue.get(request_id)
            if job['status'] in expected:
                return job
            time.sleep(0.05)
        self.fail(f'Request did not reach {expected}: {job}')

    def test_process_failure_is_not_a_completed_video(self):
        self.queue.command_factory = lambda *_args: [sys.executable, '-c', 'raise RuntimeError("test failure")']
        job = self.queue.submit(payload(), 'fail:0')
        self.queue.start()
        final = self.wait_status(job['id'], ['FAILED'])
        self.assertIn('failed', final['error'])

    def test_failed_request_can_be_explicitly_retried_under_same_id(self):
        job = self.queue.submit(payload(), 'retry:0')
        self.queue.db.execute("UPDATE requests SET status='FAILED',error='out of memory' WHERE id=?", (job['id'],))
        self.queue.db.commit()
        resumed = self.queue.retry(job['id'])
        self.assertEqual(resumed['id'], job['id'])
        self.assertEqual(resumed['status'], 'IN_QUEUE')
        with self.assertRaises(RequestError):
            self.queue.retry(job['id'])

    def test_cancel_kills_the_running_inference_process(self):
        self.queue.command_factory = lambda *_args: [sys.executable, '-c', 'import time; time.sleep(60)']
        job = self.queue.submit(payload(), 'cancel:0')
        self.queue.start()
        self.wait_status(job['id'], ['IN_PROGRESS'])
        self.queue.cancel(job['id'])
        self.wait_status(job['id'], ['CANCELLED'])
        self.assertIsNone(self.queue.process)

    def test_authenticated_http_and_actual_video_result(self):
        self.queue.command_factory = lambda request, output: ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=24', '-t', '0.5', '-c:v', 'libx264', str(output)]
        token = 'test-only-token-' + 'a' * 32
        server = make_server(self.queue, token, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.queue.start()
        base = f'http://127.0.0.1:{server.server_port}'
        try:
            with self.assertRaises(urllib.error.HTTPError) as failure:
                urllib.request.urlopen(base + '/health')
            self.assertEqual(failure.exception.code, 401)
            req = urllib.request.Request(base + '/requests', data=json.dumps(payload()).encode(), headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'Idempotency-Key': 'http:0'})
            with urllib.request.urlopen(req) as response:
                job = json.load(response)
            self.wait_status(job['request_id'], ['COMPLETED'])
            req = urllib.request.Request(base + f'/requests/{job["request_id"]}/video', headers={'Authorization': f'Bearer {token}'})
            with urllib.request.urlopen(req) as response:
                video = response.read()
            self.assertEqual(video[4:8], b'ftyp')
            self.assertGreater(len(video), 1000)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
