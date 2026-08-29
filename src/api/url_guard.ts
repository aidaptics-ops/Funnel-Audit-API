import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";

export interface UrlGuardOptions {
  allowPrivateHosts?: boolean;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; code: string; message: string };

/** Longest URL we accept; well past any real landing-page link. */
const MAX_URL_LENGTH = 2048;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Hostnames that always resolve to the machine or to the platform itself. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/** Suffixes reserved for the local network or for internal platform DNS. */
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".home.arpa",
  ".lan",
  ".intranet",
  ".corp",
  ".home",
  ".private",
  ".consul",
  ".cluster.local",
  ".svc",
];

/**
 * Validates a user-supplied target URL before the browser ever sees it.
 *
 * This is an SSRF control, not a formatting nicety: the analyser fetches
 * whatever it is handed, so a hostname resolving inside the deployment network
 * would expose cloud metadata and internal services.
 *
 * This check is lexical only. A public name whose A record points inside the
 * network passes it; resolveAndValidateUrl adds the DNS lookup and should be
 * preferred wherever the caller can await.
 *
 * Pre-flight validation cannot fully close DNS rebinding - a public name can
 * still resolve to a private address at connect time, or change between the
 * check and the request. The same guard is therefore applied again to every
 * link the crawler follows (the link checker takes an isAllowedUrl hook), and a
 * hardened deployment should also block outbound traffic to private ranges at
 * the network layer.
 */
export function validateTargetUrl(raw: unknown, options: UrlGuardOptions = {}): UrlCheck {
  if (typeof raw !== "string") {
    return fail("invalid_url", "A URL string is required.");
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return fail("invalid_url", "The URL is empty.");
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    return fail("url_too_long", `The URL exceeds the ${MAX_URL_LENGTH} character limit.`);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fail("invalid_url", "The URL could not be parsed.");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    const scheme = url.protocol.replace(":", "");
    return fail("unsupported_scheme", `Only http and https are supported, got "${scheme}".`);
  }

  // Credentials are rejected even in local-development mode: they are never
  // needed to analyse a public landing page and would end up in logs.
  if (url.username !== "" || url.password !== "") {
    return fail("credentials_not_allowed", "Credentials embedded in the URL are not accepted.");
  }

  if (url.hostname === "") {
    return fail("invalid_url", "The URL has no host.");
  }

  if (!options.allowPrivateHosts && isPrivateHostname(url.hostname)) {
    return fail("private_host", "That host is private, loopback or link-local and cannot be analysed.");
  }

  return { ok: true, url };
}

export function isAllowedUrl(raw: string, options: UrlGuardOptions = {}): boolean {
  return validateTargetUrl(raw, options).ok;
}

/**
 * The lexical check plus a DNS resolution, so a *public* name whose A/AAAA
 * record points at 169.254.169.254, 10.0.0.0/8 or any other reserved range is
 * rejected before the browser is asked to load it. Every returned address must
 * pass; one private answer rejects the whole host.
 *
 * This does NOT defeat DNS rebinding. The name can resolve differently on the
 * next lookup - the one the browser itself performs - so the load-bearing
 * control remains the per-request guard the capture pipeline installs on the
 * browser context, and the real fix is restricting network egress to private
 * ranges at the host or network layer. This check only closes the trivial case
 * where a stable public name simply points inside.
 *
 * validateTargetUrl and isAllowedUrl stay synchronous on purpose: they are
 * called from hooks (per-request routing, link filtering) that cannot await.
 */
export async function resolveAndValidateUrl(raw: unknown, options: UrlGuardOptions = {}): Promise<UrlCheck> {
  const check = validateTargetUrl(raw, options);
  if (!check.ok) return check;
  if (options.allowPrivateHosts) return check;

  const hostname = check.url.hostname;
  // An IP literal never goes to a resolver; validateTargetUrl already ran the
  // range checks on it, and lookup() would only echo it back.
  if (isIpLiteral(hostname)) return check;

  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail("dns_resolution_failed", `The host "${hostname}" could not be resolved (${detail}).`);
  }

  if (addresses.length === 0) {
    return fail("dns_resolution_failed", `The host "${hostname}" resolved to no addresses.`);
  }

  for (const entry of addresses) {
    if (isPrivateHostname(entry.address)) {
      return fail(
        "private_host",
        `The host "${hostname}" resolves to ${entry.address}, which is private, loopback or reserved.`,
      );
    }
  }

  return check;
}

/** True for a dotted/packed IPv4 or a bracketed or bare IPv6 literal. */
function isIpLiteral(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return bare.includes(":") || normalizeIpv4(bare) !== null;
}

/**
 * True when the hostname names the local machine, a private or reserved
 * network, or a cloud metadata endpoint. Accepts a bare hostname or the
 * bracketed form the URL parser produces for IPv6 literals.
 */
export function isPrivateHostname(hostname: string): boolean {
  // Every trailing dot comes off, not just one: a resolver treats "localhost",
  // "localhost." and "localhost.." as the same name, so stripping a single dot
  // would let the double-dotted spelling walk past the blocklist.
  const host = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (host === "") return true;
  // An empty interior label never appears in a real public name; it only shows
  // up in attempts to defeat a string comparison.
  if (host.includes("..")) return true;

  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "") return true;

  if (BLOCKED_HOSTNAMES.has(bare)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => bare.endsWith(suffix))) return true;

  if (bare.includes(":")) {
    const groups = parseIpv6(bare);
    // A colon-bearing host that will not parse is not a usable public name.
    return groups === null ? true : isPrivateIpv6(groups);
  }

  const dotted = normalizeIpv4(bare);
  if (dotted !== null) return isPrivateIpv4(dotted);

  // A single-label name can only resolve through a local search domain, a hosts
  // file or an internal DNS zone. A public landing page never lives at
  // "http://intranet/", so treat it as internal rather than guessing.
  if (!bare.includes(".")) return true;

  return false;
}

/**
 * Normalises every IPv4 spelling a resolver accepts - dotted quad, dotted
 * triple or pair, bare decimal, octal (leading zero) and hex (0x) - down to a
 * dotted quad, so 2130706433, 0x7f000001 and 0177.0.0.1 all collapse onto
 * 127.0.0.1 before the range check runs.
 */
function normalizeIpv4(input: string): string | null {
  const parts = input.split(".");
  if (parts.length === 0 || parts.length > 4) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    const value = parseIpv4Part(part);
    if (value === null) return null;
    numbers.push(value);
  }

  const last = numbers.pop();
  if (last === undefined) return null;
  // The final part absorbs every byte the earlier parts did not name.
  if (last >= 256 ** (4 - numbers.length)) return null;
  if (numbers.some((value) => value > 255)) return null;

  let address = last;
  for (let index = 0; index < numbers.length; index += 1) {
    address += (numbers[index] ?? 0) * 256 ** (3 - index);
  }
  if (!Number.isSafeInteger(address) || address < 0 || address > 0xffffffff) return null;

  return [(address >>> 24) & 255, (address >>> 16) & 255, (address >>> 8) & 255, address & 255].join(".");
}

function parseIpv4Part(part: string): number | null {
  if (part === "") return null;

  let radix = 10;
  let digits = part;
  if (part.startsWith("0x")) {
    radix = 16;
    digits = part.slice(2);
    if (digits === "") return 0;
  } else if (/^0[0-7]+$/.test(part)) {
    radix = 8;
    digits = part.slice(1);
  }

  const pattern = radix === 16 ? /^[0-9a-f]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!pattern.test(digits)) return null;

  const value = Number.parseInt(digits, radix);
  return Number.isSafeInteger(value) ? value : null;
}

function isPrivateIpv4(dotted: string): boolean {
  const [a = 0, b = 0, c = 0] = dotted.split(".").map(Number);

  if (a === 0) return true; // 0.0.0.0/8, including the unspecified address
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, includes 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking range
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224 && a <= 239) return true; // multicast
  if (a >= 240) return true; // reserved, plus the broadcast address

  return false;
}

/** Expands an IPv6 literal (including an embedded IPv4 tail) to eight groups. */
function parseIpv6(input: string): number[] | null {
  let text = input;

  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(":")) return null;

  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const dotted = normalizeIpv4(tail);
    if (dotted === null) return null;
    const bytes = dotted.split(".").map(Number);
    const high = (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)).toString(16);
    const low = (((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array.from({ length: missing }, () => "0"), ...rest];
  }

  const values: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    values.push(Number.parseInt(group, 16));
  }
  return values;
}

function isPrivateIpv6(groups: number[]): boolean {
  const g = (index: number): number => groups[index] ?? 0;

  if (groups.every((value) => value === 0)) return true; // ::
  if (groups.slice(0, 7).every((value) => value === 0) && g(7) === 1) return true; // ::1

  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form: the
  // real destination is the embedded IPv4 address, so re-check that instead.
  const leadingZeroes = groups.slice(0, 5).every((value) => value === 0);
  if (leadingZeroes && (g(5) === 0xffff || g(5) === 0)) {
    const dotted = [(g(6) >> 8) & 255, g(6) & 255, (g(7) >> 8) & 255, g(7) & 255].join(".");
    return isPrivateIpv4(dotted);
  }

  // Transition ranges carry an IPv4 destination inside an IPv6 address, so the
  // range check that matters is the IPv4 one run on the embedded address:
  // 2002::7f00:1 and 64:ff9b::a00:1 reach loopback and 10.0.0.1 respectively.
  if (g(0) === 0x0064 && g(1) === 0xff9b) {
    if (g(2) === 0 && g(3) === 0 && g(4) === 0 && g(5) === 0) {
      return isPrivateIpv4(dottedFromGroups(g(6), g(7))); // 64:ff9b::/96 NAT64
    }
    if (g(2) === 0x0001) {
      // 64:ff9b:1::/48 - RFC 6052 splits the IPv4 address around the reserved
      // u octet at bits 64-71, so the four octets are not contiguous.
      const octets = [(g(3) >> 8) & 255, g(3) & 255, g(4) & 255, (g(5) >> 8) & 255];
      return isPrivateIpv4(octets.join("."));
    }
    return true;
  }
  if (g(0) === 0x2002) return isPrivateIpv4(dottedFromGroups(g(1), g(2))); // 2002::/16 6to4
  if (g(0) === 0x2001 && g(1) === 0) return true; // 2001::/32 Teredo
  if (g(0) === 0x0100 && g(1) === 0 && g(2) === 0 && g(3) === 0) return true; // 100::/64 discard

  if ((g(0) & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g(0) & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g(0) & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g(0) & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  return false;
}

/** Reads a 32-bit IPv4 address out of two consecutive IPv6 groups. */
function dottedFromGroups(high: number, low: number): string {
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join(".");
}

function fail(code: string, message: string): UrlCheck {
  return { ok: false, code, message };
}
