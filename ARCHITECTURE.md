# Architecture

## Upload commit

The browser registers an upload with its filename, declared media type, byte count, and optional retry key. The API selects the object key and reserves the upload under a per-user lock so concurrent requests cannot exceed the quota. It starts a real S3 multipart upload. The browser sends parts straight to storage and records ETags, while the API obtains authoritative part numbers, sizes, and ETags from S3. A refresh can restore the upload session, and the user can reselect the original file to transfer only the missing parts.

Completion claims the session, validates the complete part set and total length, assembles the object, and inspects its metadata in storage. In one PostgreSQL transaction, the API records completion, creates the processing job, and adds the outbox entry. Repeated requests return the existing state or a retryable conflict while verification is active. A reconciliation pass repairs interrupted transitions. Cancellation and deletion have their own guarded transitions and cleanup runs independently of the original request.

## Dispatch and processing

The outbox dispatcher claims ready rows with an expiring lease, publishes an SQS message containing the stable video and job IDs, and records publication. A crash after publishing can cause another delivery. The worker claims eligible jobs in PostgreSQL and uses a unique lease token and expiration to authorize writes. Heartbeats renew the database lease and SQS visibility. Retries use bounded backoff. Queue redrive isolates messages that repeatedly fail delivery or processing. Recovery processes stranded jobs and cleans obsolete attempts.

Development startup checks port availability and applies pending migrations before launching the application services. API readiness checks PostgreSQL, the bucket, and the queue. The worker checks PostgreSQL, the queue, and its permitted media prefix after validating its FFmpeg runtime. Readiness responses are separate from user-facing video states.

A worker stages the source on disk and probes the media before encoding. It checks container and codecs, source dimensions, duration, and stream metadata. FFmpeg emits a thumbnail and H.264 video with AAC audio where present. The ladder adapts to the source display dimensions and portrait or landscape orientation. Each rendition uses aligned keyframes for switching. The worker validates the master, variants, and segments and verifies uploaded artifacts. It uploads under an attempt-specific key prefix, then atomically commits the selected prefix, asset metadata, and READY state. Deletion and stale leases fence publication. Temporary files and unpublished attempts are cleaned up after errors or shutdown.

## Delivery and retention

The API gives authorized viewers short-lived grants bound to a video and its published prefix. It serves rewritten manifests and, locally, streams bytes from private storage. In AWS it emits direct CloudFront-signed URLs in manifests and gives CloudFront permission to read derived assets. The distribution checks the signature on every request, including cache hits. Share revocation blocks further grants and manifest requests. CDN URLs issued earlier expire at the grant deadline.

Originals are kept until the owner deletes the video. This preserves the source for recovery and future reprocessing. S3 aborts incomplete multipart uploads after one day, and API reconciliation cleans expired session records and known partial objects. The API expresses a bounded query and the UI loads further pages on demand.

## Tradeoffs

- PostgreSQL holds the state machine and durable dispatch record. SQS can redeliver independently, so leases and conditional writes preserve correctness.
- Disk staging enables seekable inputs and validates the full rendition set before publication. Local disk and Fargate task storage bound the largest active job.
- Application rate limits are per API instance. Public deployments can add an edge rate limit or a shared limiter to enforce an aggregate policy across replicas.
- Native HLS uses browser-managed adaptation. The explicit quality selector is available when hls.js controls playback.
- Browser refresh recovery relies on S3 parts and file reselection. Browsers generally require explicit consent to regain filesystem access.
- This stack uses a single AWS region and maintains an external PostgreSQL dependency. Replication, backups, and restore objectives are configured with that database.
