import { Suspense } from "react";
import { AuthForm } from "@/components/auth-form";
import { LoadingState } from "@/components/feedback";

export const metadata = { title: "Create account" };

export default function RegisterPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AuthForm register />
    </Suspense>
  );
}
