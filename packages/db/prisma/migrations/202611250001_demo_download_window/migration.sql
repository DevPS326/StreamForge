ALTER TABLE "DemoTurn" ADD COLUMN "videoId" TEXT, ADD COLUMN "readyAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "DemoTurn_videoId_key" ON "DemoTurn"("videoId");
ALTER TABLE "Video" ADD COLUMN "demoExpiresAt" TIMESTAMP(3);
CREATE INDEX "Video_demoExpiresAt_idx" ON "Video"("demoExpiresAt");
ALTER TABLE "DemoTurn" ADD COLUMN "egressBytes" INTEGER NOT NULL DEFAULT 0;
