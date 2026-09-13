"""One isolated GPU inference process per request; all model files load locally."""
import argparse
import json
import os
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'


def frame_shape(aspect, resolution):
    # Wan2.2's spatial compression/patch size requires multiples of 32.
    # 1080p is an export size: generation remains at the model's 704-line profile.
    width, height = (832, 480) if resolution == '480p' else (1280, 704)
    if aspect == '9:16':
        return height, width
    if aspect == '1:1':
        return height, height
    return width, height


def preflight(model_dir):
    result = {'ready': False, 'model': 'Wan2.2-TI2V-5B', 'native_audio': False}
    try:
        import torch
        from diffusers import WanPipeline, WanImageToVideoPipeline, AutoencoderKLWan  # noqa: F401
        if not torch.cuda.is_available():
            result['reason'] = 'No CUDA GPU is available to the worker. Check the NVIDIA driver and container GPU access.'
            return result
        props = torch.cuda.get_device_properties(0)
        result.update(gpu=props.name, vram_gib=round(props.total_memory / 1024 ** 3, 1))
        if not torch.cuda.is_bf16_supported():
            result['reason'] = 'This profile requires a GPU with bfloat16 support.'
            return result
        root = Path(model_dir)
        if not (root / 'model_index.json').is_file() or not all(any((root / folder).glob('*.safetensors')) for folder in ['transformer', 'vae', 'text_encoder']):
            result['reason'] = 'Download the Wan model into WAN_MODEL_DIR before starting generation.'
            return result
        result.update(ready=True, reason='GPU and local model files detected. Model loading and a real smoke test are still required.')
    except ImportError:
        result['reason'] = 'Install the GPU worker dependencies (PyTorch, Diffusers, Transformers and Accelerate).'
    except Exception as error:
        result['reason'] = f'GPU preflight failed: {type(error).__name__}.'
    return result


def generate(request_path, output_path, model_dir):
    import torch
    from diffusers import AutoencoderKLWan, WanPipeline, WanImageToVideoPipeline
    from diffusers.utils import export_to_video
    from PIL import Image, ImageOps

    spec = json.loads(Path(request_path).read_text())
    width, height = frame_shape(spec['aspect_ratio'], spec['resolution'])
    steps = int(os.environ.get('WAN_STEPS', '50'))
    if not 1 <= steps <= 100:
        raise ValueError('WAN_STEPS must be between 1 and 100.')
    model_dir = str(Path(model_dir).resolve())
    # from_pretrained receives a local directory and cannot download or execute remote code.
    vae = AutoencoderKLWan.from_pretrained(model_dir, subfolder='vae', torch_dtype=torch.float32, local_files_only=True)
    cls = WanImageToVideoPipeline if spec.get('image_path') else WanPipeline
    extra = {'image_encoder': None, 'image_processor': None} if spec.get('image_path') else {}
    pipe = cls.from_pretrained(model_dir, vae=vae, torch_dtype=torch.bfloat16, local_files_only=True, **extra)
    pipe.vae.enable_tiling()
    if os.environ.get('WAN_OFFLOAD', 'model') == 'sequential':
        pipe.enable_sequential_cpu_offload()
    elif os.environ.get('WAN_OFFLOAD', 'model') == 'none':
        pipe.to('cuda')
    else:
        pipe.enable_model_cpu_offload()
    kwargs = {
        'prompt': spec['prompt'], 'negative_prompt': spec['negative_prompt'],
        'height': height, 'width': width, 'num_frames': 121,
        'num_inference_steps': steps, 'guidance_scale': 5.0,
        'generator': torch.Generator(device='cpu').manual_seed(spec['seed']),
    }
    if spec.get('image_path'):
        with Image.open(spec['image_path']) as image:
            kwargs['image'] = ImageOps.pad(image.convert('RGB'), (width, height))

    def progress(_pipe, step_index, _timestep, callback_kwargs):
        print(json.dumps({'step': step_index + 1, 'steps': steps}), flush=True)
        return callback_kwargs

    kwargs['callback_on_step_end'] = progress
    with torch.inference_mode():
        frames = pipe(**kwargs).frames[0]
    export_to_video(frames, str(output_path), fps=24)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--request')
    parser.add_argument('--output')
    args = parser.parse_args()
    model_dir = os.environ.get('WAN_MODEL_DIR', './models/wan2.2-ti2v-5b')
    if args.probe:
        print(json.dumps(preflight(model_dir)))
        return
    status = preflight(model_dir)
    if not status['ready']:
        raise RuntimeError(status['reason'])
    if not args.request or not args.output:
        parser.error('--request and --output are required')
    generate(args.request, args.output, model_dir)


if __name__ == '__main__':
    main()
