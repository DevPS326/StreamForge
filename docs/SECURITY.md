# Security and privacy

- Accounts use salted scrypt password hashes. Session tokens are random and only their SHA-256 digests are stored. The API sets an HTTP-only, SameSite session cookie and adds Secure in production. The browser sends cookies from the configured same-site frontend.
- The API checks ownership on every management and upload operation. Mutations enforce allowed origins and auth endpoints have bounded per-process rate limits. A public or higher-traffic rollout can add a shared rate limit or AWS WAF.
- AWS blocks public access on the media bucket and requires TLS. Browser upload grants are specific to an upload ID and part number. Part lengths, ETags, final object size, video metadata, and quotas are independently checked. FFmpeg and FFprobe validate uploaded media under resource and subprocess limits.
- Private playback grants are signed and scoped to a single committed media prefix. CloudFront signs HTTPS URLs for derived immutable assets. Application responses with playback and share tokens use private, noncacheable headers. Exclude query strings from analytics and request logs that are shared outside the operator team.
- Share links are unlisted bearer tokens. Revocation immediately prevents new playback grants and manifest loads. Previously issued CDN segment URLs remain valid until expiry. Cached local objects require an application grant on each request.
- Deletion hides the video before asynchronous storage cleanup. Processing leases prevent an in-flight worker from publishing deleted media.
- Store production passwords and signing keys in AWS Secrets Manager. Use the documented role boundaries for the migration account, API, worker, and CloudFront. Rotate CloudFront keys using an overlap window so unexpired URLs can complete. Use disposable credentials for local development.

## Release verification

- The local service suite exercises owner and non-owner access, anonymous storage access, ungranted HLS access, share revocation, session expiry, and origin enforcement. CloudFront and AWS S3 policy behavior require independent deployed verification.
- The dependency audit initially flagged `deepmerge-ts` and `effect` under Prisma configuration. The workspace pins patched versions for that dependency path. Both `pnpm audit --audit-level high` and `pnpm audit --prod --audit-level high` reported zero known advisories after the update.
- Connection failures log a request ID and sanitized Prisma error type or code. Development request logs omit share and media URLs. Browser traces and automatic failure screenshots are disabled because they can capture request credentials and bearer URLs.
- Login and registration forms use POST and stay inert until their client handlers are ready. This prevents a native pre-hydration form submission from putting credentials in the URL.
- The worker supplies FFmpeg and FFprobe with a limited environment for executable lookup, libraries, locale, and temporary storage. Database URLs and AWS credentials stay in the worker process.
