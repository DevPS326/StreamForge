import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, statSync } from "node:fs";
import { expect, test } from "@playwright/test";

const partSize = 8 * 1024 * 1024;

function buildMultipartFixture() {
  const path = "artifacts/e2e-multipart.mp4";
  execFileSync(process.execPath, ["scripts/sample.mjs", "low", path], {
    stdio: "pipe",
  });
  const padding = Buffer.alloc(partSize + 512 * 1024 - statSync(path).size);
  // A top-level MP4 free box adds bytes without changing the real video stream.
  padding.writeUInt32BE(padding.byteLength);
  padding.write("free", 4, "ascii");
  appendFileSync(path, padding);
  return path;
}

function partNumber(url: string) {
  return new URL(url).searchParams.get("partNumber");
}

test("recovers a paused multipart upload after refresh and cancels a second upload", async ({
  page,
}) => {
  const fixture = buildMultipartFixture();
  const secondFixture = "artifacts/e2e-cancel.mp4";
  copyFileSync(fixture, secondFixture);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/register");
  await page.getByLabel("Display name").fill("Multipart test");
  await page
    .getByLabel("Email address")
    .fill(`multipart-${randomUUID()}@example.test`);
  await page
    .getByLabel("Password", { exact: true })
    .fill(randomBytes(24).toString("hex"));
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("link", { name: "Upload video", exact: true }).click();

  let holdSecond = true;
  let blockedSecond = false;
  let releaseSecond: (() => void) | undefined;
  let resumedPartOne = false;
  let firstDenied = false;

  await page.route(
    (url) => url.searchParams.has("partNumber"),
    async (route) => {
      const request = route.request();
      if (request.method() !== "PUT") return route.continue();
      if (partNumber(request.url()) === "1") {
        if (!holdSecond) resumedPartOne = true;
        if (!firstDenied) {
          firstDenied = true;
          const origin = new URL(page.url()).origin;
          await route.fulfill({
            status: 403,
            headers: { "Access-Control-Allow-Origin": origin },
            body: "Signature expired",
          });
          return;
        }
      }
      if (partNumber(request.url()) === "2" && holdSecond) {
        blockedSecond = true;
        await new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
        await route.abort().catch(() => undefined);
        return;
      }
      await route.continue();
    },
  );

  try {
    const firstStored = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        partNumber(response.url()) === "1" &&
        response.ok(),
      { timeout: 45_000 },
    );
    await page.getByLabel("Choose videos").setInputFiles(fixture);
    await firstStored;
    await expect.poll(() => blockedSecond).toBe(true);
    await page.waitForFunction(() =>
      Object.keys(localStorage).some((key) => {
        if (!key.startsWith("streamforge-uploads:")) return false;
        const saved = JSON.parse(localStorage.getItem(key) || "{}");
        return (
          saved.filename === "e2e-multipart.mp4" &&
          Boolean(saved.digests?.[1]?.etag)
        );
      }),
    );
    await page.getByRole("button", { name: "Pause e2e-multipart.mp4" }).click();
    await expect(page.getByText("Paused", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (process.env.E2E_SCREENSHOTS === "1") {
      await page.screenshot({ path: "docs/screenshots/uploads-mobile.png" });
    }
    holdSecond = false;
    releaseSecond?.();

    await page.reload();
    await expect(
      page.getByRole("button", { name: "Select file to resume" }),
    ).toBeVisible();
    await page
      .getByLabel("Original file for e2e-multipart.mp4")
      .setInputFiles(fixture);
    await expect(
      page.getByText("Upload complete", { exact: true }),
    ).toBeVisible({ timeout: 40_000 });
    expect(firstDenied).toBe(true);
    expect(resumedPartOne).toBe(false);
  } finally {
    releaseSecond?.();
  }

  await page.unrouteAll({ behavior: "wait" });
  const releaseCancel: (() => void)[] = [];
  let cancelStarted = false;
  await page.route(
    (url) => url.searchParams.has("partNumber"),
    async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      cancelStarted = true;
      await new Promise<void>((resolve) => {
        releaseCancel.push(resolve);
      });
      await route.abort().catch(() => undefined);
    },
  );

  try {
    await page.getByLabel("Choose videos").setInputFiles(secondFixture);
    await expect.poll(() => cancelStarted).toBe(true);
    await page.getByRole("button", { name: "Cancel e2e-cancel.mp4" }).click();
    await page
      .getByRole("button", { name: "Cancel upload", exact: true })
      .click();
    await expect(
      page.getByText("e2e-cancel.mp4", { exact: true }),
    ).toBeHidden();
  } finally {
    releaseCancel.forEach((resolve) => resolve());
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }

  await page.getByRole("link", { name: "View video" }).click();
  await expect(
    page.getByRole("heading", { name: "e2e-multipart" }),
  ).toBeVisible();
  await expect(page.locator("video")).toBeAttached({ timeout: 90_000 });
  await page.getByRole("button", { name: "Delete video" }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(
    page.getByRole("heading", { name: "Video library" }),
  ).toBeVisible();
});
