import type { CaptureResult } from "../../pipeline/capture.js";
import type { LinkRecord } from "../../types/index.js";
import type { LinkCheckResult, LinksSection } from "../landing_types.js";
import { registrableHost } from "../registrable_host.js";

/** Registrable host -> platform, so m./www./api. subdomains all match. */
const SOCIAL_HOSTS: ReadonlyMap<string, string> = new Map([
  ["facebook.com", "facebook"],
  ["fb.com", "facebook"],
  ["fb.me", "facebook"],
  ["instagram.com", "instagram"],
  ["instagr.am", "instagram"],
  ["linkedin.com", "linkedin"],
  ["lnkd.in", "linkedin"],
  ["x.com", "x"],
  ["twitter.com", "x"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
  ["tiktok.com", "tiktok"],
  ["threads.net", "threads"],
  ["threads.com", "threads"],
  ["whatsapp.com", "whatsapp"],
  ["wa.me", "whatsapp"],
]);

/** Registrable domains whose TLD varies by country. */
const SOCIAL_PREFIXES: ReadonlyMap<string, string> = new Map([["pinterest", "pinterest"]]);

export function buildLinks(capture: CaptureResult): LinksSection {
  const links = capture.snapshot.links;
  const finalUrl = capture.final_url;

  const uniqueHrefs = new Set<string>();
  const externalHosts = new Set<string>();
  const mailto: string[] = [];
  const tel: string[] = [];
  const social: LinksSection["social"] = [];
  const mailtoSeen = new Set<string>();
  const telSeen = new Set<string>();
  const socialSeen = new Set<string>();

  let internal = 0;
  let external = 0;
  let anchors = 0;

  for (const link of links) {
    const raw = href(link);
    if (raw === null) continue;

    if (raw.startsWith("#")) {
      uniqueHrefs.add(raw);
      // A bare "#" is a placeholder rather than a destination on the page.
      if (raw.length > 1) anchors += 1;
      continue;
    }

    const url = resolve(raw, finalUrl);
    if (!url) {
      uniqueHrefs.add(raw);
      continue;
    }

    uniqueHrefs.add(url.href);

    if (url.protocol === "mailto:") {
      const address = addressOf(url.href, "mailto:");
      if (address && !mailtoSeen.has(address.toLowerCase())) {
        mailtoSeen.add(address.toLowerCase());
        mailto.push(address);
      }
      continue;
    }

    if (url.protocol === "tel:") {
      const number = addressOf(url.href, "tel:");
      if (number && !telSeen.has(number)) {
        telSeen.add(number);
        tel.push(number);
      }
      continue;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") continue;

    if (url.hash && sameDocument(url, finalUrl)) {
      anchors += 1;
      continue;
    }

    if (sameSite(url.hostname, finalUrl)) {
      internal += 1;
      continue;
    }

    external += 1;
    const host = url.hostname.toLowerCase();
    if (host) externalHosts.add(host);

    const platform = socialPlatform(host);
    if (platform) {
      const key = `${platform}|${url.href}`;
      if (!socialSeen.has(key)) {
        socialSeen.add(key);
        social.push({ platform, url: url.href });
      }
    }
  }

  const checked = capture.link_checks;
  const broken = checked.filter((check: LinkCheckResult) => check.ok === false);

  return {
    total: links.length,
    unique: uniqueHrefs.size,
    internal,
    external,
    anchors,
    mailto,
    tel,
    social,
    external_hosts: [...externalHosts].sort(),
    checked,
    broken,
    check_summary: capture.link_check_summary,
  };
}

/* -------------------------------- helpers -------------------------------- */

function href(link: LinkRecord): string | null {
  const raw = (link.href || "").trim();
  return raw.length > 0 ? raw : null;
}

function resolve(raw: string, finalUrl: string): URL | null {
  try {
    return new URL(raw, finalUrl);
  } catch {
    return null;
  }
}

/** The address part of a mailto:/tel: URL, without headers such as ?subject=. */
function addressOf(url: string, scheme: string): string | null {
  const body = url.slice(scheme.length).split("?")[0] ?? "";
  let value = body.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // Leave the raw value; a malformed escape is still what the page carries.
  }
  return value.length > 0 ? value : null;
}

function sameDocument(url: URL, finalUrl: string): boolean {
  try {
    const base = new URL(finalUrl);
    return url.origin === base.origin && url.pathname === base.pathname && url.search === base.search;
  } catch {
    return false;
  }
}

function sameSite(host: string, finalUrl: string): boolean {
  try {
    return registrableHost(host) === registrableHost(new URL(finalUrl).hostname);
  } catch {
    return false;
  }
}

function socialPlatform(host: string): string | null {
  const registrable = registrableHost(host);
  const direct = SOCIAL_HOSTS.get(registrable);
  if (direct) return direct;

  const first = registrable.split(".")[0] ?? "";
  return SOCIAL_PREFIXES.get(first) ?? null;
}
