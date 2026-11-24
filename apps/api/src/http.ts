import { randomUUID } from "node:crypto";
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@streamforge/db";
import { API_PREFIX, type ApiConfig } from "./config";

type ErrorWithStatus = Error & { status?: number; type?: string };
const validRequestId = /^[A-Za-z0-9_-]{1,64}$/;
const AUTH_WINDOW_MS = 5 * 60_000;
const databaseUnavailable = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
]);
const AUTH_PATHS = new Map([
  [`/${API_PREFIX}/auth/login`, 25],
  [`/${API_PREFIX}/auth/register`, 12],
  [`/${API_PREFIX}/auth/me`, 25],
]);

function reply(response: Response, code: number, message: string) {
  response
    .status(code)
    .json({ statusCode: code, message, requestId: response.locals.requestId });
}

export function httpPolicy(config: ApiConfig) {
  const attempts = new Map<string, { count: number; expires: number }>();
  let nextPrune = Date.now() + AUTH_WINDOW_MS;
  const allowed = new Set([...config.webOrigins, config.apiUrl.origin]);

  return (request: Request, response: Response, next: NextFunction) => {
    const received = request.get("x-request-id");
    const id =
      received && validRequestId.test(received) ? received : randomUUID();
    response.setHeader("X-Request-ID", id);
    response.locals.requestId = id;
    if (request.path.startsWith(`/${API_PREFIX}`))
      response.setHeader("Cache-Control", "private, no-store");
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();

    const origin = request.get("origin");
    if (
      (origin && !allowed.has(origin)) ||
      (!origin && request.get("sec-fetch-site") === "cross-site")
    ) {
      return reply(response, 403, "This request origin is not allowed");
    }

    const normalizedPath = request.path.toLowerCase().replace(/\/+$/, "");
    const maxAttempts = AUTH_PATHS.get(normalizedPath);
    if (maxAttempts) {
      const now = Date.now();
      if (now >= nextPrune) {
        for (const [key, entry] of attempts)
          if (entry.expires <= now) attempts.delete(key);
        nextPrune = now + AUTH_WINDOW_MS;
      }
      const key = `${request.ip ?? request.socket.remoteAddress}:${normalizedPath}`;
      let entry = attempts.get(key);
      if (!entry || entry.expires <= now) {
        if (attempts.size >= 5_000 && !entry)
          return reply(response, 429, "Try again in a few minutes");
        entry = { count: 0, expires: now + AUTH_WINDOW_MS };
        attempts.set(key, entry);
      }
      entry.count++;
      if (entry.count > maxAttempts) {
        response.setHeader(
          "Retry-After",
          String(Math.ceil((entry.expires - now) / 1000)),
        );
        return reply(
          response,
          429,
          "Too many requests. Try again in a few minutes",
        );
      }
    }
    return next();
  };
}

export function parserError(
  error: ErrorWithStatus,
  _request: Request,
  response: Response,
  next: NextFunction,
) {
  if (error.type === "entity.too.large")
    return reply(response, 413, "The request body is too large");
  if (error.type === "entity.parse.failed")
    return reply(response, 400, "The request body must be valid JSON");
  return next(error);
}

@Catch()
export class ApiErrors implements ExceptionFilter {
  private readonly log = new Logger(ApiErrors.name);

  catch(error: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    if (response.headersSent) return;

    if (error instanceof HttpException) {
      return reply(response, error.getStatus(), error.message);
    }
    const initializing =
      error instanceof Prisma.PrismaClientInitializationError;
    const code = initializing
      ? error.errorCode
      : error instanceof Prisma.PrismaClientKnownRequestError
        ? error.code
        : undefined;
    const unavailable =
      initializing || (code !== undefined && databaseUnavailable.has(code));
    this.log.error({
      event: "request_failed",
      method: request.method,
      requestId: response.locals.requestId,
      error: error instanceof Error ? error.name : "Unknown",
      code,
    });
    if (unavailable)
      return reply(
        response,
        503,
        "StreamForge is temporarily unavailable. Try again in a moment.",
      );
    return reply(response, 500, "Something went wrong. Try again");
  }
}
