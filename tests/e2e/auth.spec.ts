import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { PrismaClient } from "@streamforge/db";

test("registers, resumes a persisted session, recovers from network failure and signs in again", async ({
  page,
  context,
}) => {
  const db = new PrismaClient();
  const email = `auth-${randomUUID()}@example.test`;
  const password = randomBytes(24).toString("hex");
  const rotatedPassword = randomBytes(24).toString("hex");
  const pageErrors: string[] = [];
  const serverErrors: number[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));
  page.on("console", (event) => {
    if (event.type() === "error" && event.text().includes("hydrated but"))
      pageErrors.push("Hydration mismatch");
  });
  page.on("response", (response) => {
    if (response.status() >= 500) serverErrors.push(response.status());
  });
  const emailField = page.getByLabel("Email address");
  const passwordField = page.getByLabel("Password", { exact: true });
  const register = page.getByRole("button", { name: "Create account" });
  const library = page.getByRole("heading", { name: "Video library" });
  try {
    await page.goto("/register");
    if (process.env.E2E_SCREENSHOTS === "1") {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(register).toBeEnabled();
      await page.screenshot({
        path: "artifacts/release/register-mobile.png",
        caret: "initial",
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "light" });
    }
    await emailField.fill("bad-email");
    await passwordField.fill(password);
    await register.click();
    expect(
      await emailField.evaluate(
        (el: HTMLInputElement) => el.validity.typeMismatch,
      ),
    ).toBe(true);

    await emailField.fill(email);
    await passwordField.fill("");
    await passwordField.pressSequentially("short");
    await register.click();
    expect(
      await passwordField.evaluate(
        (el: HTMLInputElement) => el.validity.tooShort,
      ),
    ).toBe(true);

    await passwordField.fill(password);
    const isRegistration = (url: URL) =>
      url.pathname === "/api/v1/auth/register";
    await page.route(
      isRegistration,
      (route) => route.abort("internetdisconnected"),
      { times: 1 },
    );
    await register.click();
    await expect(
      page.getByText("Could not reach StreamForge", { exact: false }),
    ).toBeVisible();
    const registered = page.waitForResponse((response) =>
      isRegistration(new URL(response.url())),
    );
    await register.click();
    expect((await registered).status()).toBe(201);
    await expect(library).toBeVisible();

    const user = await db.user.findUniqueOrThrow({
      where: { email },
      select: { id: true, _count: { select: { sessions: true } } },
    });
    expect(user._count.sessions).toBe(1);
    const cookie = (await context.cookies()).find(
      ({ name }) => name === "sf_session",
    );
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    await page.reload();
    await expect(library).toBeVisible();
    if (process.env.E2E_SCREENSHOTS === "1")
      await page.screenshot({ path: "artifacts/release/library-desktop.png" });
    await page.getByRole("link", { name: "Account" }).click();
    await page.getByLabel("Display name").fill("Verified profile");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Profile saved.")).toBeVisible();
    expect(
      await db.user.count({ where: { id: user.id, name: "Verified profile" } }),
    ).toBe(1);
    if (process.env.E2E_SCREENSHOTS === "1") {
      await page.setViewportSize({ width: 820, height: 1180 });
      await page.screenshot({ path: "artifacts/release/account-tablet.png" });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.getByLabel("Current password", { exact: true }).fill(password);
    await page
      .getByLabel("New password", { exact: true })
      .fill(rotatedPassword);
    await page.getByLabel("Confirm new password").fill(rotatedPassword);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password updated.")).toBeVisible();
    expect(
      (await context.cookies()).some(
        ({ name, value }) => name === "sf_session" && value !== cookie?.value,
      ),
    ).toBe(true);

    await db.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(0) },
    });
    await page.reload();
    await expect(page).toHaveURL(/\/login\?next=/);

    await page.goto("/register");
    await emailField.fill(email);
    await passwordField.fill(password);
    await register.click();
    await expect(
      page.getByText("An account with this email already exists"),
    ).toBeVisible();

    await page.goto("/login");
    if (process.env.E2E_SCREENSHOTS === "1") {
      await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
      await page.screenshot({
        path: "artifacts/release/login-desktop.png",
        caret: "initial",
      });
    }
    await emailField.fill(email);
    await passwordField.fill(password);
    const login = page.getByRole("button", { name: "Sign in" });
    await login.click();
    await expect(
      page.getByText("The email or password is incorrect"),
    ).toBeVisible();
    await passwordField.fill(rotatedPassword);
    await login.click();
    await expect(library).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(
      (await context.cookies()).some(({ name }) => name === "sf_session"),
    ).toBe(false);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(pageErrors).toEqual([]);
    expect(serverErrors).toEqual([]);
  } finally {
    await db.user.deleteMany({ where: { email } });
    await db.$disconnect();
  }
});
