"""One-time download of open weights; pin the resolved revision in a local lock."""
import argparse
import json
import os
from pathlib import Path


def main():
    from huggingface_hub import HfApi, snapshot_download
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', default=os.environ.get('WAN_MODEL_DIR', './models/wan2.2-ti2v-5b'))
    parser.add_argument('--revision', help='Optional exact model commit; defaults to the existing lock, otherwise resolves main once')
    args = parser.parse_args()
    root = Path(args.directory)
    lock = root / 'toon-model-lock.json'
    model = 'Wan-AI/Wan2.2-TI2V-5B-Diffusers'
    old = json.loads(lock.read_text()) if lock.exists() else {}
    revision = args.revision or old.get('revision') or HfApi().model_info(model).sha
    root.mkdir(parents=True, exist_ok=True)
    snapshot_download(model, revision=revision, local_dir=str(root), allow_patterns=['*.json', '*.safetensors', '*.model', '*.txt', 'LICENSE*', 'README*'])
    lock.write_text(json.dumps({'model': model, 'revision': revision}, indent=2) + '\n')
    print('Model downloaded. Exact revision saved in toon-model-lock.json.')


if __name__ == '__main__':
    main()
