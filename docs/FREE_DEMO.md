# Free-demo deployment and limits

The Vercel app uses Render's existing free API and worker service, Render PostgreSQL, and a private Cloudflare R2 bucket. Production smoke runs are manual. CI runs the same pipeline against an isolated PostgreSQL database and local S3-compatible object storage.

## Admission and retention

An authenticated user explicitly joins a FIFO queue of up to five waiting accounts. A PostgreSQL advisory lock serializes admission and quota changes. Admission allows one five-minute upload and processing window per user and one video per turn. Publication verifies the worker's lease and opens a new 120-second download window in the same transaction as the READY state. Requests for the previous video stop at expiry. A turn that has issued video authorization stays reserved until expiry. An untouched turn can be released. Waiting tickets expire after 15 minutes.

The download returns the original and permits a single authenticated transfer per turn. The HLS rendition is available through metered private endpoints for the same turn and video. Background reconciliation expires newly created demo media and schedules fenced deletion. Upload-session expiry aborts incomplete multipart uploads. Pre-migration videos have no demo expiration marker and remain subject to the existing retention policy. Review those records before any operational cleanup.

## Usage controls

- Eight turns per UTC day and 100 per UTC month. Five upload reservations per day and 50 per month. An exhausted monthly budget resets on the first UTC day of the next month. A 429 response carries the reason and the applicable reset timestamp.
- One active user, one FFmpeg worker, 20 MiB per file, 45 seconds, one output no higher than 480p, and two attempts. Each job is bounded by the active work deadline.
- Global storage reservation is capped at 200 MiB. The reservation covers four times the original size plus 1 MiB. The worker checks artifact sizes before publishing.
- Up to 100 HLS requests and 128 MiB of authorized response bytes per turn, including the original download. This implies up to 1 GiB per UTC day and 12.5 GiB per UTC month through metered demo responses. These are application limits. Existing reverse-proxy and per-IP limits also apply.

R2 can bill for storage and operations. Presigned multipart URLs can be retried until expiry, and provider accounting includes operations outside the metered application path. Render free services can sleep and have provider-side usage limits. Set usage alerts in Cloudflare and review Render bandwidth and Postgres expiry in the provider consoles. Keep uploads disabled if the provider budget cannot be monitored.

The current Render free PostgreSQL instance was reported to expire around December 24, 2026. Run an encrypted backup from an authorized private environment and test restoration before expiry. Keep the external database allowlist closed. No replacement database or provider plan is provisioned by this repository.

## Verification

GitHub Actions runs registration, two FIFO users, signed multipart upload, real FFmpeg, HLS retrieval, a two-minute download window, duplicate download denial, and admission after expiry using isolated services. Run the production smoke workflow manually after the Vercel and Render deployments converge, accounting for one production turn and upload. Enable the second-user check only in an isolated environment or as an explicitly budgeted production test.
