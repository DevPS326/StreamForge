
CREATE TABLE "DemoTurn" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "mediaReads" INTEGER NOT NULL DEFAULT 0,
  "downloads" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "DemoTurn_joinedAt_idx" ON "DemoTurn"("joinedAt");
CREATE INDEX "DemoTurn_expiresAt_idx" ON "DemoTurn"("expiresAt");
CREATE TABLE "DemoUsage" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "dayKey" TEXT NOT NULL,
  "dayUploads" INTEGER NOT NULL DEFAULT 0,
  "monthKey" TEXT NOT NULL,
  "monthUploads" INTEGER NOT NULL DEFAULT 0,
  "dayTurns" INTEGER NOT NULL DEFAULT 0,
  "monthTurns" INTEGER NOT NULL DEFAULT 0
);
