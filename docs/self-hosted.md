# Self-hosted video generation

Toon can now run video inference using **Wan2.2 TI2V-5B weights on your own GPU**. The Node studio talks to the included Python GPU service. There is no fal call or hosted inference account in this mode. The model is an existing open-weight model, not a new foundation model trained by Toon.

## Hardware and prerequisites

- Linux and a CUDA-capable NVIDIA GPU with bfloat16 support.
- The upstream Wan runner documents a 24 GB GPU example with offloading. That is a starting point, **not a measured guarantee for this Diffusers integration**. Actual memory use depends on frame size, offloading and library behavior.
- As a planning allowance, budget 64 GB host RAM and at least 60 GB free storage for model files, the CUDA container and video output. These are conservative setup estimates, not tested minima.
- For Docker: NVIDIA driver, Docker Compose and NVIDIA Container Toolkit. The driver must support the CUDA 12.8 PyTorch image used here.
- Internet for installation and the one-time weight download. The inference runner itself uses offline model loading.

The current workspace has no NVIDIA GPU device, PyTorch installation or model weights. Therefore real GPU inference, image conditioning quality, VRAM use and Docker execution are **not verified here**.

## Docker setup

From the repository root:

```bash
npm run setup:local
docker compose -f compose.yaml -f compose.gpu.yaml build
docker compose -f compose.yaml -f compose.gpu.yaml --profile setup run --rm model-download
docker compose -f compose.yaml -f compose.gpu.yaml up -d toon gpu
```

The first command creates `.env` or updates an existing one to local mode, preserving already-set secrets. It generates missing studio and worker secrets on your machine. Read your studio password privately from `.env`; never publish the file. The shared worker token authenticates requests to your own service. It does not require a paid account.

The model downloader resolves a model revision once, records it in `toon-model-lock.json`, and reuses it on subsequent runs. It downloads model configuration, tokenizer files and safetensors. The model files are not committed to GitHub. Keep the model lock with your deployment records.

Open `http://localhost:3000`, sign in and open **Engine settings**. When the worker, CUDA GPU and downloaded files are detected, the local path is available. This preflight does not prove sufficient free VRAM or successful inference; run the smoke test below.

The GPU service has no published Docker port. Only Toon connects to it on the private container network. To use Toon remotely, expose the studio behind HTTPS, set the exact `PUBLIC_ORIGIN`, and preserve the Host header. Do not expose an unauthenticated GPU endpoint.

## Direct installation

Install Node 24, Python 3.11, FFmpeg and the NVIDIA driver. Then:

```bash
npm run setup:local
python3 -m venv .venv
. .venv/bin/activate
pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
pip install -r gpu_service/requirements.txt
python -m gpu_service.download_model
```

Run the preflight and start the worker:

```bash
npm run gpu:probe
npm run gpu:start
```

These helpers load the same private `.env` as the studio and choose `.venv/bin/python` automatically. In another shell start Toon with `npm start`. No separate token entry or shell-history copy is needed.

## Supported local profile

| Setting | Behavior |
| --- | --- |
| Text input | Wan text-to-video diffusion pipeline |
| Reference image | Wan image-to-video pipeline using the same local 5B model |
| Duration | 121 generated frames at 24 fps; assembled to exactly 5 seconds |
| Landscape inference | 832×480 or 1280×704 |
| Portrait inference | 480×832 or 704×1280 |
| Square inference | 480×480 or 704×704 |
| 1080p selection | Resized final export from 704-line inference; not native 1080p detail |
| Audio | Wan TI2V produces silent visuals; imported clips or narration can supply audio |
| Per-request loading | Each request uses an isolated model process; loading repeats to free GPU memory reliably |
| Default steps | 50; adjustable with `WAN_STEPS` from 1 to 100 |
| Offloading | `WAN_OFFLOAD=model` by default; `sequential` trades speed for memory, `none` needs more VRAM |
| Queue | One active inference process, up to 32 pending/active requests |

Reference images and prompts are stored on your own services. Frames and request metadata remain in the configured persistent volumes. There is no automatic retention deletion; monitor and back up disk usage.

## Run the real GPU smoke test

1. Create a one-scene project, landscape, 480p, 5 seconds. Use a simple prompt describing one visible action.
2. Generate on your GPU. Confirm that the worker performs actual denoising and the finished video moves coherently; do not treat HTTP success alone as an image-quality test.
3. Download the MP4 and verify its duration, playability and expected audio behavior.
4. Attach an image and run another scene. Check that it conditions the video on the supplied image.
5. Try 720p only after the smaller run succeeds. Record GPU model, peak VRAM, host RAM, runtime and model revision.

Useful diagnosis:

```bash
docker compose -f compose.yaml -f compose.gpu.yaml logs gpu toon
```

Detailed inference errors are stored at `/app/gpu-data/<request-id>/worker.log` inside the GPU container. If CUDA runs out of memory, try `WAN_OFFLOAD=sequential`, restart the GPU container, and use **Resume saved render** to retry the failed local request under its existing ID. Switching to a different local server URL or fal while a job is in progress is blocked rather than forwarding its request handles to another service.

## Verified without a GPU

`npm test` checks the Node local adapter and its interaction with the actual Python HTTP queue, downloads a real MP4 fixture, and runs it through the existing FFmpeg assembler. `npm run test:gpu` verifies input constraints, auth, idempotency, queue persistence, cancellation, process failures and video validation. Test fixtures explicitly replace diffusion with FFmpeg; production has no mock-generation switch.

Actual CUDA generation, the complete container build and the visual UI remain unverified. No paid GPU was rented and no multi-gigabyte weight download was attempted in the CPU-only workspace.

## Sources

- [Wan2.2 upstream implementation and hardware example](https://github.com/Wan-Video/Wan2.2)
- [Wan2.2 TI2V-5B model and license information](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers)
- [Diffusers Wan pipeline documentation](https://huggingface.co/docs/diffusers/api/pipelines/wan)
- [Pinned image-to-video pipeline source](https://github.com/huggingface/diffusers/blob/v0.35.1/src/diffusers/pipelines/wan/pipeline_wan_i2v.py)
