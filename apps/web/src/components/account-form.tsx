"use client";

import { useState, type FormEvent } from "react";
import { api, message, type User } from "@/lib/api";
import { formatDate } from "@/lib/ui";
import { ErrorNotice, Field } from "./feedback";
import { useToast } from "./preferences";
import { Button } from "./ui/button";
import { useAccount } from "./workspace";

export function AccountForm() {
  const { user, setUser } = useAccount();
  const toast = useToast();
  const [working, setWorking] = useState<"profile" | "password" | null>(null);
  const [profileError, setProfileError] = useState("");
  const [passwordError, setPasswordError] = useState("");

  async function save(
    event: FormEvent<HTMLFormElement>,
    change: "profile" | "password",
  ) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const password = change === "password";
    const setError = password ? setPasswordError : setProfileError;
    setError("");
    if (password && form.get("newPassword") !== form.get("confirmPassword")) {
      setError("The new passwords must match.");
      return;
    }
    setWorking(change);
    try {
      const updated = await api<User>("/auth/me", {
        method: "PATCH",
        body: password
          ? {
              currentPassword: form.get("currentPassword"),
              newPassword: form.get("newPassword"),
            }
          : { displayName: String(form.get("displayName") || "").trim() },
      });
      setUser(updated);
      if (password) formElement.reset();
      toast(password ? "Password updated." : "Profile saved.");
    } catch (error) {
      setError(message(error));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="grid max-w-2xl gap-6">
      <header>
        <h1 className="text-4xl font-bold tracking-[-0.055em]">Account</h1>
        <p className="mt-2 text-muted">Manage your profile and password.</p>
      </header>
      <form
        onSubmit={(event) => void save(event, "profile")}
        className="grid gap-5 rounded-3xl border border-line bg-surface p-5 sm:p-7"
      >
        <h2 className="text-xl font-semibold tracking-tight">Profile</h2>
        <Field id="account-email" label="Email address">
          <input
            id="account-email"
            className="field text-muted"
            type="email"
            value={user.email}
            readOnly
          />
        </Field>
        <Field id="displayName" label="Display name">
          <input
            id="displayName"
            name="displayName"
            className="field"
            defaultValue={user.displayName || ""}
            autoComplete="name"
            maxLength={80}
            required
          />
        </Field>
        <p className="text-sm text-muted">
          Member since {formatDate(user.createdAt)}
        </p>
        {profileError && <ErrorNotice>{profileError}</ErrorNotice>}
        <Button
          type="submit"
          className="justify-self-start"
          disabled={working !== null}
        >
          {working === "profile" ? "Saving…" : "Save profile"}
        </Button>
      </form>
      <form
        onSubmit={(event) => void save(event, "password")}
        className="grid gap-5 rounded-3xl border border-line bg-surface p-5 sm:p-7"
      >
        <h2 className="text-xl font-semibold tracking-tight">
          Change password
        </h2>
        <Field id="currentPassword" label="Current password">
          <input
            id="currentPassword"
            name="currentPassword"
            type="password"
            className="field"
            autoComplete="current-password"
            maxLength={128}
            required
          />
        </Field>
        <Field id="newPassword" label="New password">
          <input
            id="newPassword"
            name="newPassword"
            type="password"
            className="field"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </Field>
        <Field id="confirmPassword" label="Confirm new password">
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            className="field"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </Field>
        {passwordError && <ErrorNotice>{passwordError}</ErrorNotice>}
        <Button
          type="submit"
          className="justify-self-start"
          disabled={working !== null}
        >
          {working === "password" ? "Changing password…" : "Change password"}
        </Button>
      </form>
    </div>
  );
}
