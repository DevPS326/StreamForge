import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import db from "./index.cjs";

if (process.env.NODE_ENV === "production")
  throw new Error("The demo account is local-only.");
const { PrismaClient } = db;
const email = process.env.DEMO_EMAIL || "demo@streamforge.local";
const password = process.env.DEMO_PASSWORD || "StreamForge-local-demo-2026!";
const salt = randomBytes(16);
const digest = await promisify(scrypt)(password, salt, 64, {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});
const prisma = new PrismaClient();
try {
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: "Demo user",
      passwordHash: `${salt.toString("hex")}:${digest.toString("hex")}`,
    },
  });
  console.log(`Demo account is available for ${email}`);
} finally {
  await prisma.$disconnect();
}
