FROM node:22-trixie-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.29.0

FROM base AS manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/

FROM manifests AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm db:generate && pnpm --filter @streamforge/api build && pnpm --filter @streamforge/worker build

FROM manifests AS migration-dependencies
RUN pnpm --filter @streamforge/db install --frozen-lockfile
COPY packages/db/prisma packages/db/prisma

FROM manifests AS production
RUN pnpm --filter @streamforge/api --filter @streamforge/worker --filter @streamforge/db install --prod --frozen-lockfile
COPY --from=build /app/packages/db/index.cjs /app/packages/db/index.d.ts /app/packages/db/
COPY --from=build /app/packages/db/generated /app/packages/db/generated

FROM debian:trixie-slim AS ffmpeg-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gcc gnupg libc6-dev libx264-dev make nasm pkg-config xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
ARG FFMPEG_VERSION=9.1
RUN curl -fsSLO https://ffmpeg.org/ffmpeg-devel.asc \
    && curl -fsSLO "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    && curl -fsSLO "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz.asc" \
    && gpg --batch --import ffmpeg-devel.asc \
    && gpg --batch --status-fd 1 --verify "ffmpeg-${FFMPEG_VERSION}.tar.xz.asc" \
       "ffmpeg-${FFMPEG_VERSION}.tar.xz" > verification.txt \
    && grep -Eq '^\[GNUPG:\] VALIDSIG FCF986EA15E6E293A5644F10B4322F04D67658D8 ' verification.txt \
    && tar -xJf "ffmpeg-${FFMPEG_VERSION}.tar.xz" --strip-components=1 \
    && ./configure --prefix=/opt/ffmpeg --enable-gpl --enable-libx264 --disable-autodetect \
       --disable-network --disable-doc --disable-ffplay \
    && make -j"$(nproc)" \
    && make install

FROM debian:trixie-slim AS runtime
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 openssl && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 node && useradd --uid 1000 --gid 1000 --create-home node
COPY --from=base /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
ENV NODE_ENV=production

FROM runtime AS migrate
COPY --from=migration-dependencies /app /app
USER node
CMD ["node", "packages/db/node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "packages/db/prisma/schema.prisma"]

FROM runtime AS api
COPY --from=production /app /app
COPY --from=build /app/apps/api/dist /app/apps/api/dist
ENV PORT=4000 HOST=0.0.0.0
EXPOSE 4000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS worker
RUN apt-get update && apt-get install -y --no-install-recommends libx264-164 && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg-build /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
COPY --from=production /app /app
COPY --from=build /app/apps/worker/dist /app/apps/worker/dist
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||'3011')+'/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/worker/dist/index.js"]
