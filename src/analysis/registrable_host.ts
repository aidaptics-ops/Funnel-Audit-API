/**
 * One definition of "same site" for the whole analysis.
 *
 * Four sections and the link checker each grew their own copy of this, and two
 * of them had already drifted: a page on example.com loading cdn.example.com
 * was third-party in one field and first-party in another, inside the same
 * response. Every caller now shares this module.
 *
 * This is a deliberately small approximation of the Public Suffix List: enough
 * to keep co.uk / com.au style hosts intact without shipping the full list.
 */
const SECOND_LEVEL_SUFFIXES = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "edu",
  "ac",
  "or",
  "ne",
  "gob",
  "govt",
  "asn",
]);

/** The registrable part of a hostname ("a.b.example.co.uk" -> "example.co.uk"). */
export function registrableHost(host: string): string {
  const lowered = (host || "").toLowerCase().replace(/\.$/, "");
  if (!lowered) return "";

  // An IP literal has no registrable domain; it only ever matches itself.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lowered) || lowered.includes(":") || lowered.startsWith("[")) {
    return lowered;
  }

  const parts = lowered.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");

  const secondLevel = parts[parts.length - 2] ?? "";
  if (SECOND_LEVEL_SUFFIXES.has(secondLevel)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

/** Whether two hostnames belong to the same registrable domain. */
export function isSameSite(a: string, b: string): boolean {
  const left = registrableHost(a);
  const right = registrableHost(b);
  return left !== "" && left === right;
}

/** Convenience for callers holding URLs rather than hostnames. */
export function hostOf(url: string, base?: string): string | null {
  try {
    return new URL(url, base).hostname;
  } catch {
    return null;
  }
}
