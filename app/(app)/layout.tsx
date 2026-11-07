import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/app-shell";

/** Every page inside this route group is wrapped in the navigation shell. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

