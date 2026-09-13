# Toon Studio

An AI video-making engine and browser studio with self-hosted Wan inference, inspired by the actual Flashloop workflow: **idea → scenes → generated moving footage → assembled MP4**.

This project follows the clarification in this chat. It does not implement the event photo-wall interpretation in the attached PDF.

## What works

- Text-to-video and first-frame image-to-video on your own GPU using **Wan 2.2 TI2V-5B**. No fal API key or credits required in local mode.
- Optional **Wan 2.5 on fal** adapter, selected explicitly with `VIDEO_PROVIDER=fal`.
- Editable multi-scene storyboards, scene ordering, visual styles, per-scene seeds and reference images.
- Saved, reusable characters: description plus reference image. These condition the model; they do not guarantee identical appearance across independent generations.
- Optional AI storyboard writing through your **Ollama** model. Without it, paragraph splitting and manual scene writing work locally.
- Durable SQLite projects and render jobs, provider request handles, status polling, cancellation, restart recovery, and explicit handling of uncertain submissions.
- Real FFmpeg assembly: H.264 MP4, portrait/landscape/square output, 480p/720p/1080p, captions, silent output or source audio, optional uploaded narration.
- Import existing MP4 clips, combine them with generated scenes, preview, download MP4, and export SRT captions.
- Private single-owner access, server-only provider key, HTTP-only signed session cookies, origin checks, upload validation, and restricted provider download hosts.
- Docker configuration and GitHub Actions tests that render actual video fixtures.

**Status:** first runnable version. Local media rendering and simulated provider responses are tested. Actual Wan GPU inference has **not** been verified in this workspace: no CUDA GPU or model weights are available here. The two-service integration is tested with an explicitly simulated inference process. Paid fal inference is also unverified. The app never substitutes a demo video for a failed generation. It does not contain newly trained video-model weights or claim Flashloop feature parity.

## Run on your own GPU with Docker

Use a Linux machine with an NVIDIA GPU, a working NVIDIA driver and NVIDIA Container Toolkit. The upstream project gives a 24 GB GPU example for its offloaded 5B runner; memory usage in this Diffusers integration must be checked on your hardware. See [self-hosted setup](docs/self-hosted.md).

```bash
npm run setup:local
docker compose -f compose.yaml -f compose.gpu.yaml build
docker compose -f compose.yaml -f compose.gpu.yaml --profile setup run --rm model-download
docker compose -f compose.yaml -f compose.gpu.yaml up -d toon gpu
```

The setup command prepares `.env` and generates a private studio password and worker secret locally. Neither is a purchased API key. View the studio password in your private `.env` file; do not commit or share that file. The one-time model download needs internet access and substantial disk space. Inference then loads the downloaded weights locally with Hugging Face offline mode enabled.

Open `http://localhost:3000`. The GPU API is private to the Docker network. Projects, GPU jobs and weights live in persistent volumes. **Engine settings** reports a missing worker, missing dependencies, missing weights or missing GPU instead of pretending generation is ready.

## Run directly

Install **Node.js 24** and **FFmpeg / FFprobe** (with libx264, drawtext and a font installed). No npm packages are required: the server uses Node's built-in HTTP, SQLite, crypto and fetch APIs.

```bash
cp .env.example .env
npm start
```

Open `http://localhost:3000`. Direct mode binds to loopback by default and does not require a password until exposed beyond loopback. Start the GPU worker separately as described in [self-hosted setup](docs/self-hosted.md). Configure `SELF_HOSTED_URL` and your own shared worker secret in `.env`. To use fal instead, explicitly select `VIDEO_PROVIDER=fal` and provide `FAL_KEY`.

## Make a video

1. Enter a title and story idea. Separate paragraphs into scenes, use a configured AI writer, or write each shot directly.
2. Add the character description or load a saved character. Optionally attach a reference image for the project or an individual shot.
3. Choose style, aspect ratio, resolution, duration, captions and audio. You can import an MP4 into any scene to bypass generation for that scene.
4. Select **Generate video** and review the render settings. Local generation uses your own hardware; only the optional fal mode consumes provider credits.
5. The server renders in the background. Return to the project to see progress, preview the finished film, and download it from the studio or **My videos**.

Local generated scenes are 5 seconds. The optional fal adapter and imported clips also support 10 seconds. A render contains up to eight scenes. Local inference uses up to 1280×704 frames; a selected 1080p export is an upscale, not native 1080p generation. Imported clips are trimmed to the selected scene duration, or their final frame is held if shorter. Image inputs are letterboxed to the selected format. Reference images must be 360–2000 pixels per side and no more than 10 MB. Supported imports are MP4 (100 MB / 90 seconds), and narration MP3/WAV (20 MB / 120 seconds).

Silent output removes all source audio at export. **Keep model / clip audio** preserves whatever soundtrack the source contains. Uploaded narration replaces the scene soundtrack and is included as supplied, padded or trimmed to the final film length. Toon does not automatically distinguish speech from music.

## Optional AI script writer

Use an Ollama installation you control with a model able to produce structured JSON. Set the URL and the exact installed model name:

```dotenv
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=your-installed-model-name
```

For Docker, use the reachable address of your Ollama service; container loopback is not the host machine. Restart Toon after changing configuration. **Write with AI** then becomes available. Merely configuring the model does not verify its availability; failures are shown in the studio.

## Test

```bash
npm run check
npm test
```

Run `npm run test:gpu` as well to test the Python worker without installing a GPU framework. Cross-service tests substitute a deterministic FFmpeg fixture for diffusion and never label it as AI output. Tests exercise API access controls, real uploads/downloads, byte-range playback, input validation, request idempotency, provider errors, crash recovery, cancellation, and actual silent/audio/captioned MP4 rendering. Provider HTTP responses are mocked; no paid requests are made by tests. Browser visual QA and a live provider smoke test remain separate checks.

## Deployment and operation

Use one persistent Node process/container with FFmpeg on a VPS or container host, with a writable data volume and a connection to your private GPU worker. Only optional fal mode needs outbound HTTPS access to fal and its media hosts. This engine cannot run on static GitHub Pages or a Cloudflare Worker: FFmpeg subprocesses and local SQLite require a server. GitHub stores and tests the code; it is not the inference GPU or the production media server.

Set `PUBLIC_ORIGIN` to the exact browser origin and preserve the Host header through your reverse proxy. Use HTTPS and a strong `STUDIO_PASSWORD`. The password protects the entire single-owner studio; this is not a multi-tenant SaaS service. Run one engine process per database. Back up the complete data directory together with SQLite state while the process is stopped, or use a consistent SQLite backup strategy. Generated videos consume disk; no automatic retention deletion is configured.

If a render reports **needs review**, a network failure may have occurred after fal accepted a paid submission. Check the provider queue before creating another render. Known request handles can be resumed without resubmission; uncertain ones are not blindly retried. Cancelling a running request is best-effort and may not reverse provider charges.

## Reference material

- [Wan 2.2 upstream code](https://github.com/Wan-Video/Wan2.2)
- [Wan 2.2 TI2V-5B model](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers)
- [Flashloop](https://www.flashloop.app/) — workflow reference; no proprietary implementation is copied.
- [Wan 2.5 text-to-video API](https://fal.ai/models/fal-ai/wan-25-preview/text-to-video/api)
- [Wan 2.5 image-to-video API](https://fal.ai/models/fal-ai/wan-25-preview/image-to-video/api)
- [fal asynchronous queue API](https://fal.ai/docs/documentation/model-apis/inference/queue)
- [Ollama chat API](https://docs.ollama.com/api/chat)

See [architecture and coverage](docs/architecture.md) for implementation boundaries and remaining work.
