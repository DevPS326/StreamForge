export function log(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) {
  const message = JSON.stringify({
    ...fields,
    time: new Date().toISOString(),
    level,
    event,
  });
  if (level === "info") console.log(message);
  else console.error(message);
}

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2000,
  );
}
