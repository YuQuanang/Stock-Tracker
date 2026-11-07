/**
 * Only allow redirects to paths inside this app, so a crafted
 * /login?next=https://evil.example link cannot bounce you to another site
 * (an "open redirect").
 */
export function getSafeNextPath(candidate: string | null | undefined): string {
  const fallback = "/dashboard";

  if (candidate === null || candidate === undefined) {
    return fallback;
  }

  const isRelativePath = candidate.startsWith("/");
  // "//host" and "/\host" are treated by browsers as protocol-relative URLs.
  const isProtocolRelative = candidate.startsWith("//") || candidate.startsWith("/\\");
  const isLoginPage = candidate === "/login" || candidate.startsWith("/login?");

  if (!isRelativePath || isProtocolRelative || isLoginPage) {
    return fallback;
  }
  return candidate;
}

