import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import {
  BadRequestException,
  Body,
  CanActivate,
  ConflictException,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Prisma } from "@streamforge/db";
import type { Request, Response } from "express";
import { z } from "zod";
import { API_CONFIG, API_PREFIX, type ApiConfig } from "./config";
import { Database } from "./database";
import { documentedBody, validate } from "./validation";

const SESSION_COOKIE = "sf_session";
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const HASH_SETTINGS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DUMMY_HASH = `${"0".repeat(32)}:${"0".repeat(128)}`;
const nameSchema = z.string().trim().min(1, "Enter a display name").max(80);
const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters for your password")
  .max(128);
const suppliedPassword = z.string().min(1).max(128);
const loginSchema = z.object({
  email: emailSchema,
  password: suppliedPassword,
});
const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: nameSchema.optional(),
});
const updateSchema = z
  .object({
    displayName: nameSchema.optional(),
    currentPassword: suppliedPassword.optional(),
    newPassword: passwordSchema.optional(),
  })
  .refine(
    ({ displayName, newPassword }) =>
      displayName !== undefined || newPassword !== undefined,
    "Provide an account change",
  )
  .refine(
    ({ newPassword, currentPassword }) =>
      newPassword === undefined || currentPassword !== undefined,
    "Enter your current password",
  );

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, HASH_SETTINGS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function digest(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

export function newSecret() {
  return randomBytes(32).toString("base64url");
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function passwordMatches(
  password: string,
  hash: string = DUMMY_HASH,
) {
  const [salt, expected] = hash.split(":");
  if (
    !/^[0-9a-f]{32}$/.test(salt ?? "") ||
    !/^[0-9a-f]{128}$/.test(expected ?? "")
  )
    return false;
  return timingSafeEqual(
    await derive(password, Buffer.from(salt, "hex")),
    Buffer.from(expected, "hex"),
  );
}

const userFields = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;
type PublicUser = Prisma.UserGetPayload<{ select: typeof userFields }>;

function userResponse({ id, email, name, createdAt }: PublicUser) {
  return { id, email, displayName: name, createdAt };
}

export type AuthenticatedRequest = Request & {
  auth: { sessionId: string; user: PublicUser };
};

function readSessionCookie(request: Request) {
  const value = request.headers.cookie
    ?.split(";")
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(Database) private readonly db: Database) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readSessionCookie(request);
    if (!token) throw new UnauthorizedException("Sign in to continue");
    const session = await this.db.session.findUnique({
      where: { tokenHash: digest(token) },
      select: { id: true, expiresAt: true, user: { select: userFields } },
    });
    if (!session || session.expiresAt <= new Date())
      throw new UnauthorizedException("Your session has expired");
    request.auth = { sessionId: session.id, user: session.user };
    if (
      process.env.DEMO_FREE_MODE === "1" &&
      /^\/api\/v1\/(uploads|videos)(?:\/|$)/.test(request.path)
    ) {
      const turn = await this.db.demoTurn.findUnique({
        where: { userId: session.user.id },
      });
      if (!turn?.expiresAt || turn.expiresAt <= new Date())
        throw new HttpException(
          "Your free demo slot has expired. Join the waiting queue.",
          429,
        );
    }
    return true;
  }
}

@ApiTags("Authentication")
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.apiUrl.protocol === "https:",
      sameSite: "lax" as const,
      path: `/${API_PREFIX}`,
    };
  }

  private setCookie(response: Response, token: string) {
    response.cookie(SESSION_COOKIE, token, {
      ...this.cookieOptions(),
      maxAge: SESSION_TTL,
    });
  }

  private sessionData(token: string) {
    return {
      tokenHash: digest(token),
      expiresAt: new Date(Date.now() + SESSION_TTL),
    };
  }

  @Post("register")
  @documentedBody(registerSchema)
  @ApiOperation({ summary: "Create an account and issue a session cookie" })
  async register(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { email, password, displayName } = validate(registerSchema, body);
    const token = newSecret();
    try {
      const user = await this.db.user.create({
        data: {
          email,
          name: displayName ?? email.split("@")[0].slice(0, 80),
          passwordHash: await hashPassword(password),
          sessions: { create: this.sessionData(token) },
        },
        select: userFields,
      });
      this.setCookie(response, token);
      return userResponse(user);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "An account with this email already exists",
        );
      }
      throw error;
    }
  }

  @Post("login")
  @HttpCode(200)
  @documentedBody(loginSchema)
  @ApiOperation({ summary: "Verify credentials and issue a session cookie" })
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { email, password } = validate(loginSchema, body);
    const user = await this.db.user.findUnique({
      where: { email },
      select: { ...userFields, passwordHash: true },
    });
    const matches = await passwordMatches(password, user?.passwordHash);
    if (!matches || !user)
      throw new UnauthorizedException("The email or password is incorrect");

    const token = newSecret();
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
      const active = await tx.user.findUnique({
        where: { id: user.id },
        select: { passwordHash: true },
      });
      if (active?.passwordHash !== user.passwordHash)
        throw new UnauthorizedException("Please sign in again");
      await tx.session.deleteMany({
        where: { userId: user.id, expiresAt: { lte: new Date() } },
      });
      const sessions = await tx.session.findMany({
        where: { userId: user.id },
        select: { id: true },
        orderBy: { createdAt: "desc" },
        skip: 9,
        take: 100,
      });
      if (sessions.length)
        await tx.session.deleteMany({
          where: { id: { in: sessions.map(({ id }) => id) } },
        });
      await tx.session.create({
        data: { userId: user.id, ...this.sessionData(token) },
      });
    });
    this.setCookie(response, token);
    return userResponse(user);
  }

  @Post("logout")
  @HttpCode(204)
  @ApiOperation({ summary: "Revoke the current session" })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = readSessionCookie(request);
    if (token)
      await this.db.session.deleteMany({ where: { tokenHash: digest(token) } });
    response.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  @Get("me")
  @UseGuards(SessionGuard)
  @ApiCookieAuth("sf_session")
  @ApiOperation({ summary: "Read the signed-in account" })
  me(@Req() request: AuthenticatedRequest) {
    return userResponse(request.auth.user);
  }

  @Patch("me")
  @UseGuards(SessionGuard)
  @ApiCookieAuth("sf_session")
  @documentedBody(updateSchema)
  @ApiOperation({
    summary: "Update the display name or rotate the password and sessions",
  })
  async update(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { displayName, currentPassword, newPassword } = validate(
      updateSchema,
      body,
    );
    const { id } = request.auth.user;
    if (!newPassword) {
      const user = await this.db.user.update({
        where: { id },
        data: { name: displayName },
        select: userFields,
      });
      return userResponse(user);
    }

    const current = await this.db.user.findUniqueOrThrow({
      where: { id },
      select: { passwordHash: true },
    });
    if (
      !currentPassword ||
      !(await passwordMatches(currentPassword, current.passwordHash))
    ) {
      throw new BadRequestException("The current password is incorrect");
    }
    const passwordHash = await hashPassword(newPassword);
    const token = newSecret();
    const user = await this.db.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id, passwordHash: current.passwordHash },
        data: { name: displayName, passwordHash },
      });
      if (!updated.count)
        throw new ConflictException(
          "Your account changed. Please sign in again",
        );
      await tx.session.deleteMany({ where: { userId: id } });
      await tx.session.create({
        data: { userId: id, ...this.sessionData(token) },
      });
      return tx.user.findUniqueOrThrow({ where: { id }, select: userFields });
    });
    this.setCookie(response, token);
    return userResponse(user);
  }
}
