import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";
import { getSafeNextPath } from "@/lib/auth/safe-next";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const rawNext = typeof params.next === "string" ? params.next : null;

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-10">
      <LoginForm nextPath={getSafeNextPath(rawNext)} />
    </main>
  );
}

