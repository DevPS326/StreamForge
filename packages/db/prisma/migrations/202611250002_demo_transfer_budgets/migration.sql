CREATE TABLE "DemoTransferUsage" (
  "id" INTEGER NOT NULL,
  "dayKey" TEXT NOT NULL,
  "monthKey" TEXT NOT NULL,
  "dayBytes" BIGINT NOT NULL DEFAULT 0,
  "monthBytes" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "DemoTransferUsage_pkey" PRIMARY KEY ("id")
);
