import { BadRequestException } from "@nestjs/common";
import { ApiBody, type ApiBodyOptions } from "@nestjs/swagger";
import { z } from "zod";

export function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues[0]?.message ?? "Invalid request",
    );
  }
  return result.data;
}

export const uuid = z.uuid({ error: "Invalid identifier" });
export const title = z
  .string()
  .trim()
  .min(1, "Enter a title")
  .max(160, "Titles can contain up to 160 characters");
export const opaqueSecret = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Invalid access token");

type OpenApiBodySchema = Extract<ApiBodyOptions, { schema: unknown }>["schema"];

export function documentedBody(schema: z.ZodType) {
  const { $schema: _dialect, ...body } = z.toJSONSchema(schema, {
    io: "input",
    target: "openapi-3.0",
  });
  return ApiBody({ schema: body as OpenApiBodySchema });
}
