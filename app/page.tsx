import { redirect } from "next/navigation";

/** The proxy has already confirmed a session, so go straight to the app. */
export default function RootPage() {
  redirect("/dashboard");
}
