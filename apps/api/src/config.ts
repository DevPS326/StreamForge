import { z } from "zod";

export const API_PREFIX = "api/v1";
const GIB = 1024 ** 3;

const settings = z.object({
  DATABASE_URL: z.string().min(1),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  API_PUBLIC_URL: z.url().default("http://localhost:4000"),
  MEDIA_TOKEN_SECRET: z.string().min(32),
  MEDIA_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(900),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ENDPOINT: z.url().optional(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  SQS_ENDPOINT: z.url().optional(),
  SQS_QUEUE_URL: z.url(),
  CLOUDFRONT_URL: z.url().optional(),
  CLOUDFRONT_KEY_PAIR_ID: z.string().min(1).optional(),
  CLOUDFRONT_PRIVATE_KEY: z.string().min(1).optional(),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(5 * 1024 * GIB)
    .default(5 * GIB),
  USER_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(20 * GIB),
  MAX_ACTIVE_UPLOADS: z.coerce.number().int().min(1).max(100).default(20),
  UPLOAD_EXPIRY_HOURS: z.coerce.number().int().min(1).max(72).default(24),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
});

export function parseConfig(env: NodeJS.ProcessEnv) {
  const defined = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== ""),
  );
  const parsed = settings.safeParse(defined);
  if (!parsed.success) {
    throw new Error(
      `Invalid API settings: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  }
  const config = parsed.data;
  const webOrigins = config.WEB_ORIGIN.split(",").map((origin) => {
    const url = new URL(origin.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("WEB_ORIGIN must contain HTTP(S) origins");
    }
    return url.origin;
  });
  const apiUrl = new URL(config.API_PUBLIC_URL);
  if (
    !["http:", "https:"].includes(apiUrl.protocol) ||
    apiUrl.pathname !== "/" ||
    apiUrl.search ||
    apiUrl.hash
  ) {
    throw new Error("API_PUBLIC_URL must be an HTTP(S) origin");
  }
  const cloudfrontValues = [
    config.CLOUDFRONT_URL,
    config.CLOUDFRONT_KEY_PAIR_ID,
    config.CLOUDFRONT_PRIVATE_KEY,
  ];
  if (cloudfrontValues.some(Boolean) && !cloudfrontValues.every(Boolean)) {
    throw new Error(
      "CloudFront configuration requires the URL, key pair ID, and private key",
    );
  }
  if (config.CLOUDFRONT_URL) {
    const url = new URL(config.CLOUDFRONT_URL);
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("CLOUDFRONT_URL must be an HTTPS origin");
    }
  }
  return { ...config, apiUrl, webOrigins };
}

export type ApiConfig = ReturnType<typeof parseConfig>;
export const API_CONFIG = Symbol("API_CONFIG");
