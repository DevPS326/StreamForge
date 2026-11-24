# Testing

## Unit, media, and database suites

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

FFmpeg and FFprobe must be on the path for media fixtures and worker tests. The worker tests generate real media, validate HLS playlists, decode and seek, and cover landscape, portrait, no audio, short clips, unsupported media, and unusual dimensions.

Run the repository setup first, then enable the worker’s database lease, rollback, and ElasticMQ DLQ tests. Set `WORKER_TEST_CRASH=1` to additionally kill a worker during FFmpeg execution and verify successful SQS redelivery to a replacement worker.

```sh
WORKER_TEST_DATABASE_URL='postgresql://streamforge:streamforge@localhost:5432/streamforge?schema=public' \
WORKER_TEST_ELASTICMQ_ENDPOINT=http://localhost:9324 \
node --env-file=.env scripts/run.mjs pnpm --filter @streamforge/worker test
```

## API and browser

```sh
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

Use an already running local stack. Set `E2E_BROWSER_CHANNEL=chrome` to exercise installed Google Chrome's H.264 decoder. Set `E2E_IPV4=1` when a different local service occupies the IPv6 loopback web port. The service suite verifies real multipart upload, part reuse, expired signatures, concurrent completion, lease-fenced duplicate delivery, storage privacy, manifest and segment access, revocation, and deletion. The browser suite covers authentication, background encoding, private adaptive playback, sharing, and resumed upload interactions.

The authentication test uses `DATABASE_URL` to verify a persisted session and expire only its generated test account. Run against the local database used by the API. Set `E2E_SCREENSHOTS=1` to capture selected screens. The suite avoids automatic traces and failure screenshots because they can include credentials or signed links.

## Local load

Install k6 and run an isolated local stack. The default creates and then cancels five simultaneous upload sessions. Opt in to larger or sustained runs.

```sh
k6 run tests/load/smoke.js
LOAD_MODE=browse LOAD_VUS=10 LOAD_DURATION=15s k6 run tests/load/smoke.js
LOAD_VUS=100 k6 run tests/load/smoke.js
LOAD_MODE=complete LOAD_VUS=10 k6 run tests/load/smoke.js
```

The API limits account creation per IP in a rolling window. Use a fresh local process when running consecutive scenarios that would exceed the limit. The complete scenario exercises the storage commit path with test bytes and cleans up the videos after submitting them.

Prepare a valid padded MP4 and interrupt the transfer after 32 parts to exercise recovery with a new process.

```sh
pnpm sample
node scripts/pad-sample.mjs
LOAD_STOP_AFTER_PARTS=32 node --env-file=.env tests/load/large-upload.mjs artifacts/one-gib.mp4
node --env-file=.env tests/load/large-upload.mjs artifacts/one-gib.mp4
```

The resumed run reports the storage parts it reused and only uploads the missing ranges. Measurements from this test describe one local environment and the synthetic test file. See the [implementation and verification record](IMPLEMENTATION_STATUS.md) for executed results.
