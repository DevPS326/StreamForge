# Release verification

## Registration incident

The browser sent a JSON `POST http://localhost:4000/api/v1/auth/register` with `email`, `password`, and optionally `displayName`. Docker Desktop's Linux engine was initially unavailable. An isolated API pointed at an unreachable PostgreSQL port reproduced the exact HTTP 500 and **Something went wrong. Try again**. The NestJS log for the request reported `PrismaClientInitializationError`. With PostgreSQL reachable, Chrome registered a fresh user and opened the library. The existing database had the initial migration and no pending migrations. The original historical request log was unavailable.

The API now returns HTTP 503 with recovery guidance for connection initialization and defined transient database errors. Browser requests have a 30-second deadline. Login, registration, logout, and expired-session handling each perform a single navigation. Login and registration forms stay inert until hydration and use POST even before JavaScript loads.

An existing Next.js process also occupied port 3000. A second development launch attempted port 3001 and stopped when Next detected the existing instance. The launcher now rejects occupied ports, applies migrations before starting the app, and waits for web, API, and worker readiness before announcing the URL. On Windows, Ctrl+C stopped the development task tree and released ports 3000, 4000, and 3011.

## Test evidence

| Check                                                                      | Result                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                           | Passed                                                                                                                                                                                                      |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`           | Passed                                                                                                                                                                                                      |
| `pnpm test`                                                                | 33 API tests and 10 worker tests passed. The default run skipped five opt-in worker tests.                                                                                                                  |
| Worker tests with database, ElasticMQ, and crash flags                     | 15 passed, 0 skipped. Includes real FFmpeg, lease fencing, worker interruption and replacement, and DLQ redrive.                                                                                            |
| `pnpm test:integration` against fresh Linux containers                     | 3 passed and 0 failed. Includes multipart completion races, duplicate queue delivery, storage privacy, HLS authorization, share revocation, corrupt input, cancellation, and expiry.                        |
| `pnpm audit --audit-level high` and `pnpm audit --prod --audit-level high` | Zero known advisories after two Prisma transitive dependencies were updated.                                                                                                                                |
| `docker compose --profile app build migrate api worker`                    | All three Linux images built. Each image runs as the `node` user. An isolated Compose project applied the initial migration to an empty PostgreSQL database and reported healthy API and worker containers. |

Chrome passed all 3 browser tests. Coverage includes persisted authentication, profile and password updates, offline recovery, invalid and duplicate registration, expiry, real media upload and playback, search, keyboard seeking, decoded 480p playback, speed, mute, fullscreen, renaming, guest playback and revocation, deletion, and multipart recovery after refresh. Reviewed captures include mobile registration and upload, tablet profile, and desktop login, library, player, and share playback.

`terraform init -backend=false` and `terraform validate` passed with Terraform 1.14.0 and AWS provider 6.74.0 in an isolated Linux workspace.

## Container security

Docker Scout found 1 critical and 39 high findings in each of the initial API and migration images and 3 critical and 110 high findings in the initial worker image. Those images included package-manager tooling and Debian Bookworm's FFmpeg. The Debian security tracker identifies the Bookworm and Trixie FFmpeg packages as affected by CVE-2026-75143. [Debian security tracker](https://security-tracker.debian.org/tracker/CVE-2026-75143)

The revised Dockerfile uses separate Trixie runtime stages without npm or pnpm. The worker builds FFmpeg 9.1 from the signed upstream release and verifies it against the upstream release-signing fingerprint before compiling. Network protocols are disabled in the FFmpeg build. [FFmpeg releases and signature verification](https://ffmpeg.org/download.html)

The rescanned API and migration images each have zero critical findings. Docker Scout still assigns high severity to CVE-2026-107493, CVE-2026-107496, CVE-2026-84786, and CVE-2026-121482 in the system OpenSSL package. OpenSSL rates all four low and lists 3.5.10 as fixed. The Trixie images contain the 3.5.9 package shipped by Debian. The scan gate remains failed. [OpenSSL advisories](https://openssl-library.org/news/vulnerabilities-3.5/index.html) [Debian package status](https://security-tracker.debian.org/tracker/source-package/openssl)

## Local measurements

These measurements used a Windows 11 host with 12 logical processors and 16 GB RAM, Node.js 22.14.0, Docker Engine 29.4.2, application containers, PostgreSQL 16, Silo, and ElasticMQ. The worker had a 3 CPU and 3 GiB limit. The workload used disposable accounts and synthetic media. Latencies exclude cloud network paths.

| Workload                                  | Result                                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 100 concurrent upload reservations        | 100 succeeded, 0 failed, 1.19 s elapsed, 1,099.76 ms p95                                                                                       |
| 100 concurrent cancellations              | 100 succeeded, 0 failed, 0.33 s elapsed, 288.32 ms p95                                                                                         |
| 10 concurrent multipart completions       | 10 succeeded, 0 failed, 0.28 s elapsed, 276.66 ms p95                                                                                          |
| 10 concurrent library clients             | 570 succeeded, 0 failed, 15.21 s elapsed, 19.84 ms p95                                                                                         |
| 1 GiB padded MP4, interrupted and resumed | Sent 256 MiB in 6.92 s, then reused 32 stored parts and sent the remaining 768 MiB in 27.78 s                                                  |
| Linux FFmpeg on the completed 1 GiB input | READY at 1280×720 after 31.54 s of polling following upload completion. One in-flight worker sample measured 124.41% CPU and 92.49 MiB memory. |

The 1 GiB fixture contains 12 seconds of video and an MP4 padding box. It exercises large object transfer and storage recovery. Transcoding time depends on the encoded content.

See the deployment guide for same-site Vercel/API domains, Secrets Manager values, migration tasks, image digests, and rollback. [Deployment guide](DEPLOYMENT.md)
