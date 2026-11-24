import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@streamforge/db";

const api = new URL(process.env.SMOKE_ORIGIN + "/api/v1");
const database = new URL(process.env.DATABASE_URL);
for (const target of [api, database])
  assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.equal(database.pathname, "/streamforge_demo_verify");
const db = new PrismaClient();
const accounts = [];

async function request(path, { cookie, body } = {}) {
  const response = await fetch(api.href + path, {
    method: "POST",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  return { response, result };
}

try {
  assert.equal(
    await db.demoTurn.count(),
    0,
    "Use an empty isolated demo database",
  );
  assert.equal(
    await db.demoUsage.count(),
    0,
    "Use an empty isolated demo database",
  );
  for (let i = 0; i < 7; i++) {
    const { response, result } = await request("/auth/register", {
      body: {
        email: randomUUID() + "@example.test",
        password: randomBytes(24).toString("base64url"),
      },
    });
    assert.equal(response.status, 201);
    accounts.push({
      id: result.id,
      cookie: response.headers.get("set-cookie").split(";")[0],
    });
  }
  const join = (account) => request("/demo/join", account);
  const first = await Promise.all(accounts.slice(0, 2).map(join));
  assert.deepEqual(first.map(({ result }) => result.state).sort(), [
    "active",
    "queued",
  ]);
  const activeIndex = first.findIndex(
    ({ result }) => result.state === "active",
  );
  const oversized = await request("/uploads", {
    cookie: accounts[activeIndex].cookie,
    body: {
      filename: "oversized.mp4",
      mimeType: "video/mp4",
      size: 21 * 1024 * 1024,
    },
  });
  assert.ok([400, 413].includes(oversized.response.status));
  for (let i = 2; i < 6; i++) {
    const { result } = await join(accounts[i]);
    assert.equal(result.position, i);
  }
  const full = await join(accounts[6]);
  assert.equal(full.response.status, 429);
  assert.equal(full.result.reason, "QUEUE_FULL");
  assert.ok(Number(full.response.headers.get("retry-after")) > 0);

  await db.demoTurn.deleteMany({
    where: { userId: { in: accounts.map(({ id }) => id) } },
  });
  const today = new Date();
  const checks = [
    {
      reason: "DAILY_TURNS",
      setting: { dayTurns: 8 },
      reset: Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + 1,
      ),
    },
    {
      reason: "MONTHLY_TURNS",
      setting: { monthTurns: 100 },
      reset: Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1),
    },
    {
      reason: "DAILY_UPLOADS",
      setting: { dayUploads: 5 },
      reset: Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + 1,
      ),
    },
    {
      reason: "MONTHLY_UPLOADS",
      setting: { monthUploads: 50 },
      reset: Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1),
    },
  ];
  for (const { reason, setting, reset } of checks) {
    await db.demoUsage.update({
      where: { id: 1 },
      data: {
        dayTurns: 0,
        monthTurns: 0,
        dayUploads: 0,
        monthUploads: 0,
        ...setting,
      },
    });
    const { response, result } = await join(accounts[0]);
    assert.equal(response.status, 429);
    assert.equal(result.reason, reason);
    assert.equal(result.retryAt, new Date(reset).toISOString());
    assert.ok(Number(response.headers.get("retry-after")) > 0);
  }
  console.log(
    "Concurrent FIFO intake, queue cap, upload size and four UTC quota resets passed",
  );
} finally {
  if (accounts.length) {
    const ids = accounts.map(({ id }) => id);
    await db.demoTurn.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.demoUsage.deleteMany({ where: { id: 1 } });
  }
  await db.$disconnect();
}
