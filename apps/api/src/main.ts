import "reflect-metadata";
import { ConsoleLogger, Logger, Module, RequestMethod } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import express from "express";
import helmet from "helmet";
import { AuthController, SessionGuard } from "./auth";
import { API_CONFIG, API_PREFIX, parseConfig } from "./config";
import { Database } from "./database";
import { HealthController } from "./health";
import { ApiErrors, httpPolicy, parserError } from "./http";
import { MediaController, VideoPresenter } from "./media";
import { OutboxDispatcher } from "./outbox";
import { Storage } from "./storage";
import { UploadController, Uploads } from "./uploads";
import { ShareController, VideoController } from "./videos";

@Module({
  controllers: [
    HealthController,
    AuthController,
    UploadController,
    VideoController,
    ShareController,
    MediaController,
  ],
  providers: [
    Database,
    Storage,
    SessionGuard,
    Uploads,
    VideoPresenter,
    OutboxDispatcher,
    { provide: API_CONFIG, useFactory: () => parseConfig(process.env) },
  ],
})
class AppModule {}

export async function createApplication() {
  const config = parseConfig(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: new ConsoleLogger({ json: true }),
  });
  app.set("trust proxy", config.TRUST_PROXY_HOPS || false);
  app.disable("x-powered-by");
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: "health/live", method: RequestMethod.GET },
      { path: "health/ready", method: RequestMethod.GET },
    ],
  });
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      strictTransportSecurity:
        config.apiUrl.protocol === "https:" ? undefined : false,
      referrerPolicy: { policy: "no-referrer" },
      contentSecurityPolicy: {
        directives: {
          upgradeInsecureRequests: null,
          scriptSrc: ["'self'", "'unsafe-inline'"],
        },
      },
    }),
  );
  const origins = new Set([...config.webOrigins, config.apiUrl.origin]);
  app.enableCors({
    origin: (origin, done) =>
      done(null, Boolean(origin && origins.has(origin))),
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Range", "X-Request-ID"],
    exposedHeaders: ["Accept-Ranges", "Content-Range", "X-Request-ID"],
    maxAge: 600,
  });
  app.use(httpPolicy(config));
  app.use(express.json({ limit: "32kb" }));
  app.use(parserError);
  app.useGlobalFilters(new ApiErrors());
  const specification = new DocumentBuilder()
    .setTitle("StreamForge API")
    .setDescription(
      "Account sessions, video management, multipart uploads, unlisted sharing, and scoped HLS delivery.",
    )
    .setVersion("1.0")
    .addCookieAuth("sf_session", { type: "apiKey" }, "sf_session")
    .build();
  SwaggerModule.setup("api/docs", app, () =>
    SwaggerModule.createDocument(app, specification),
  );
  return { app, config };
}

if (require.main === module) {
  void createApplication()
    .then(async ({ app, config }) => {
      app.enableShutdownHooks();
      await app.listen(config.PORT, config.HOST);
    })
    .catch((error: unknown) => {
      const reason =
        error instanceof Error ? error.message : "Unknown startup error";
      new Logger("Bootstrap").error(reason);
      process.exitCode = 1;
    });
}
