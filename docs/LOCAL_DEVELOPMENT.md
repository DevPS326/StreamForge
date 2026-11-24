# Local development

`docker compose up -d` starts PostgreSQL 16, the private Silo bucket, and ElasticMQ. Silo is a maintained S3-compatible MinIO fork. The published upstream MinIO images were unavailable from both registries during verification. All published development ports bind to loopback. [Silo project](https://github.com/pgsty/silo)

| Service                    | Address                                                   |
| -------------------------- | --------------------------------------------------------- |
| Web                        | `http://localhost:3000`                                   |
| API and Swagger UI         | `http://localhost:4000`, `http://localhost:4000/api/docs` |
| PostgreSQL                 | `localhost:5432`                                          |
| Object storage and console | `http://localhost:9000`, `http://localhost:9001`          |
| Queue                      | `http://localhost:9324`                                   |
| Worker readiness           | `http://127.0.0.1:3011/ready`                             |

Copy `.env.example` to `.env` for a new checkout. From the repository root, run:

```sh
docker compose up -d
pnpm dev
```

`pnpm dev` checks the application ports, applies pending migrations, and reports readiness once the web, API, and worker respond successfully. `pnpm db:seed` and `pnpm sample` are optional. Keep the same `localhost` hostnames in the browser and settings to keep authentication, CORS, and presigned URLs consistent. Press Ctrl+C in the development terminal to stop the app processes.

### Container mode

```sh
docker compose --profile app up -d --build
pnpm --filter @streamforge/web dev
```

The profile builds the API and worker and runs the migration task before either starts. Run the Next.js app from the host. Its default rewrite uses the API at `http://localhost:4000`.

### Troubleshooting

- If a port is already in use, check its listener before stopping any process. Use the existing StreamForge session if it is healthy.
- Run `docker compose ps -a` and `docker compose logs storage-init queue postgres` to check startup. The bucket initialization job should exit with status 0.
- If you use Docker Desktop, start its Linux engine before running Compose. Check `docker version` when the client cannot connect.
- If authentication behaves inconsistently, open the browser at `http://localhost:3000`. Check the configured API origin and inspect cookie settings.
- When a part fails, resume from the current upload row and reselect the same file if prompted. The browser asks for fresh signed URLs and uses the server’s known part list.
- Check `ffmpeg -version`, `ffprobe -version`, worker readiness, and worker logs when a valid upload stays in Processing. A corrupt or unsupported source reaches Failed.
- To stop the containers and retain data, run `docker compose --profile app down`. For an intentional full local reset, `docker compose --profile app down -v` removes the PostgreSQL, Silo, and queue volumes. Run the setup commands again to rebuild them.
