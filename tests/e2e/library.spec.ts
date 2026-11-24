import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("registers, streams HLS, shares, revokes, deletes, and signs out", async ({
  page,
  browser,
}) => {
  const fixture = "artifacts/e2e-landscape.mp4";
  execFileSync(process.execPath, ["scripts/sample.mjs", "landscape", fixture], {
    stdio: "pipe",
  });

  const email = `browser-${randomUUID()}@example.test`;
  const password = randomBytes(24).toString("hex");
  const videoName = "e2e-landscape";
  await page.goto("/register");
  await page.getByLabel("Display name").fill("Browser test");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("heading", { name: "Video library" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page
    .getByRole("link", { name: "Upload video", exact: true })
    .first()
    .click();
  await page.locator("input[type=file]").setInputFiles(fixture);
  await expect(
    page.getByText("Upload complete", { exact: true }).first(),
  ).toBeVisible({ timeout: 30_000 });

  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search videos" });
  await search.fill("title-that-does-not-exist");
  await expect(page.getByText("No matching videos")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByLabel("Sort videos").selectOption("title");
  await page
    .getByRole("link", { name: videoName, exact: false })
    .first()
    .click();
  const video = page.locator("video");
  await expect(video).toBeAttached({ timeout: 100_000 });
  const play = page.getByRole("button", { name: "Play", exact: true });
  await play.click();
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.3);
  const quality = page.getByLabel("Playback quality");
  await expect.poll(() => quality.locator("option").count()).toBeGreaterThan(2);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const seek = page.getByRole("slider", { name: "Seek" });
  await expect(seek).toBeEnabled();
  await seek.press("End");
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime))
    .toBeGreaterThan(5);
  await quality.selectOption({ label: "480p" });
  await expect(quality.locator("option:checked")).toHaveText("480p");
  await seek.press("Home");
  await play.click();
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.videoHeight))
    .toBe(480);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByLabel("Playback speed").selectOption("1.5");
  await expect(video).toHaveJSProperty("playbackRate", 1.5);
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(video).toHaveJSProperty("muted", true);
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Exit fullscreen" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Exit fullscreen" }).click();
  if (process.env.E2E_SCREENSHOTS === "1") {
    await page.screenshot({
      path: "docs/screenshots/watch.png",
      fullPage: true,
    });
    const library = await page.context().newPage();
    await library.goto("/");
    await expect(
      library.getByText("Ready", { exact: true }).first(),
    ).toBeVisible();
    await library.screenshot({ path: "docs/screenshots/library.png" });
    await library.close();
  }
  const privateUrl = page.url();

  await page.getByRole("button", { name: "Rename video" }).click();
  await page.getByLabel("Video title").fill("A test film");
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(
    page.getByRole("heading", { name: "A test film" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Share video" }).click();
  await page.getByRole("button", { name: "Create share link" }).click();
  const linkField = page.getByRole("textbox", {
    name: "Share link",
    exact: true,
  });
  await expect(linkField).toHaveValue(/\/share\//);
  const link = await linkField.inputValue();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(linkField).toBeHidden();

  const guest = await browser.newContext();
  let releaseManifest: () => void = () => undefined;
  const holdManifest = new Promise<void>((resolve) => {
    releaseManifest = resolve;
  });
  try {
    const guestPage = await guest.newPage();
    await guestPage.route(
      /\/api\/v1\/media\/[^/]+\/master\.m3u8\?/,
      async (route) => {
        await holdManifest;
        await route.continue();
      },
    );
    await guestPage.goto(link, { waitUntil: "domcontentloaded" });
    await expect(
      guestPage.getByRole("heading", { name: "A test film" }),
    ).toBeVisible();
    const sharedVideo = guestPage.locator("video");
    await expect(sharedVideo).toBeAttached();
    const guestPlay = guestPage.getByRole("button", {
      name: "Play",
      exact: true,
    });
    await expect(guestPlay).toBeDisabled();
    releaseManifest();
    await guestPlay.click();
    await expect
      .poll(() =>
        sharedVideo.evaluate((el) => (el as HTMLVideoElement).currentTime),
      )
      .toBeGreaterThan(0.1);
    if (process.env.E2E_SCREENSHOTS === "1") {
      await guestPage.screenshot({
        path: "artifacts/release/share-desktop.png",
        fullPage: true,
      });
    }

    await page.getByRole("button", { name: "Share video" }).click();
    const revoke = page.getByRole("button", { name: "Revoke link" });
    await revoke.click();
    await expect(page.getByText("Share link revoked.")).toBeVisible();
    await expect(linkField).toBeHidden();
    await guestPage.reload();
    await expect(
      guestPage.getByText(
        "This share link is unavailable or has been revoked.",
      ),
    ).toBeVisible();
    await expect(guestPage.locator("video")).toHaveCount(0);
    const privatePage = await guest.newPage();
    const authResponse = privatePage.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/v1/auth/me",
      { timeout: 15_000 },
    );
    await privatePage.goto(privateUrl, { waitUntil: "domcontentloaded" });
    expect((await authResponse).status()).toBe(401);
    await expect(privatePage).toHaveURL(/\/login\?next=/);
  } finally {
    releaseManifest();
    await guest.close();
  }

  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Delete video" }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(
    page.getByRole("heading", { name: "Video library" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /A test film/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
});
