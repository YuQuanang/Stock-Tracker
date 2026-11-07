import { NextResponse } from "next/server";
import { z } from "zod";
import { LedgerUserError } from "@/lib/services/ledger";

/**
 * Converts service and validation errors into clean, human-readable JSON
 * responses without leaking internal stack traces or credentials.
 */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof LedgerUserError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.statusCode },
    );
  }

  if (error instanceof z.ZodError) {
    const firstIssue = error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".") || "Input"}: ${firstIssue.message}`
      : "Invalid request data.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  console.error("Unhandled API error:", error instanceof Error ? error.message : "unknown");
  return NextResponse.json(
    { error: "Something went wrong on the server. Please try again." },
    { status: 500 },
  );
}

