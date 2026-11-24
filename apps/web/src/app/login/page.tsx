import { Suspense } from "react";
import { AuthForm } from "@/components/auth-form";
import { LoadingState } from "@/components/feedback";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AuthForm register={false} />
    </Suspense>
  );
}
