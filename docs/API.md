# REST API

Swagger is at `/api/docs` and its OpenAPI document is at `/api/docs-json`. The application prefix is `/api/v1`. Errors include `statusCode`, `message`, and `requestId`. The API sends `X-Request-ID` on each response.

| Method and path                         | Behavior                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`                   | Create an account from `email`, `password`, and optional `displayName`                                  |
| `POST /auth/login`                      | Authenticate and set the HTTP-only session cookie                                                       |
| `GET /auth/me`                          | Return the signed-in account                                                                            |
| `PATCH /auth/me`                        | Update the display name or change password with the current password                                    |
| `POST /auth/logout`                     | End the current session                                                                                 |
| `GET /videos`                           | List the owner’s videos with `search`, `sort`, `limit`, and opaque `cursor`                             |
| `GET /videos/{id}`                      | Return current video information and playback grant when Ready                                          |
| `PATCH /videos/{id}`                    | Set `title`                                                                                             |
| `DELETE /videos/{id}`                   | Revoke access and schedule cleanup                                                                      |
| `POST /videos/{id}/share`               | Create or rotate an unlisted share token                                                                |
| `DELETE /videos/{id}/share`             | Revoke the active share token                                                                           |
| `GET /share/{token}`                    | Return playable information for a valid unlisted link                                                   |
| `GET /uploads`                          | Find active sessions available for recovery                                                             |
| `POST /uploads`                         | Start or recover an upload by `filename`, `mimeType`, `size`, and optional `title` or UUID `requestKey` |
| `GET /uploads/{id}`                     | Return part size and the current server-side part list                                                  |
| `POST /uploads/{id}/parts`              | Issue URLs for the requested `partNumbers`                                                              |
| `POST /uploads/{id}/complete`           | Verify the storage parts and durably enqueue processing                                                 |
| `DELETE /uploads/{id}`                  | Cancel an incomplete upload and schedule cleanup                                                        |
| `GET /media/{id}/{path}?grant=…`        | Serve authorized manifests or media                                                                     |
| `GET /health/live`, `GET /health/ready` | Check service liveness and dependencies. These paths are outside the versioned prefix                   |

Upload part URLs require PUT with the exact part content length. Use the returned part size for each part except the last. A successful response exposes the ETag. A 409 from completion can indicate another request already owns verification or required parts are missing. Read the upload session and retry when the part set is complete.
