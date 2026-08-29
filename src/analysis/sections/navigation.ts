import type { CaptureResult } from "../../pipeline/capture.js";
import type { DomSnapshot, LinkRecord } from "../../types/index.js";
import type { NavigationSection } from "../landing_types.js";
import { registrableHost } from "../registrable_host.js";

const MAX_NAV_ITEMS = 60;
const MAX_FOOTER_ITEMS = 60;
const NAV_TEXT_CHARS = 160;

/** Paths that address the site root rather than a sub-page. */
const ROOT_PATHS = new Set(["", "/", "/index.html", "/index.htm", "/index.php"]);

type NavItem = NavigationSection["nav_items"][number];

export function buildNavigation(capture: CaptureResult): NavigationSection {
  const snapshot = capture.snapshot;
  const finalUrl = capture.final_url;

  const navLinks = snapshot.links.filter((link) => link.visible && link.in_nav);
  const footerLinks = snapshot.links.filter((link) => link.visible && link.in_footer);

  const navItems = dedupe(navLinks, finalUrl).slice(0, MAX_NAV_ITEMS);
  const footerItems = dedupe(footerLinks, finalUrl).slice(0, MAX_FOOTER_ITEMS);

  return {
    has_navigation: navItems.length > 0,
    nav_item_count: navItems.length,
    nav_items: navItems,
    footer_item_count: footerItems.length,
    footer_items: footerItems,
    exit_links_above_fold: countExitLinksAboveFold(snapshot.links, finalUrl),
    logo_links_home: logoLinksHome(navLinks, snapshot, finalUrl),
  };
}

/* -------------------------------- items --------------------------------- */

function dedupe(links: LinkRecord[], finalUrl: string): NavItem[] {
  const seen = new Set<string>();
  const items: NavItem[] = [];

  for (const link of links) {
    const text = trim(link.text);
    const href = link.href && link.href.trim() ? link.href.trim() : null;
    const key = `${text.toLowerCase()}|${href ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ text, href, external: isExternal(href, finalUrl) });
  }

  return items;
}

/**
 * Distinct off-site destinations reachable without scrolling. Repeated links to
 * the same URL are one escape route, so they are counted once.
 */
function countExitLinksAboveFold(links: LinkRecord[], finalUrl: string): number {
  const hrefs = new Set<string>();
  for (const link of links) {
    if (!link.visible || link.position !== "above_fold") continue;
    const resolved = resolve(link.href, finalUrl);
    if (!resolved || !isHttp(resolved)) continue;
    if (sameSite(resolved.hostname, finalUrl)) continue;
    hrefs.add(resolved.href);
  }
  return hrefs.size;
}

/* --------------------------------- logo ---------------------------------- */

/**
 * A logo link cannot be seen directly: LinkRecord carries no child elements. Two
 * observable stand-ins are accepted — a nav anchor with no text at all (an
 * anchor wrapping an image or icon) and a nav anchor whose text is the brand
 * name from the document title or og:site_name. Either must point at the site
 * root on the same site. Anything less certain returns false.
 */
function logoLinksHome(navLinks: LinkRecord[], snapshot: DomSnapshot, finalUrl: string): boolean {
  const brands = brandCandidates(snapshot);

  for (const link of navLinks) {
    const text = link.text.replace(/\s+/g, " ").trim();
    const looksLikeLogo = text.length === 0 || brands.has(text.toLowerCase());
    if (!looksLikeLogo) continue;

    const resolved = resolve(link.href, finalUrl);
    if (!resolved || !isHttp(resolved)) continue;
    if (!sameSite(resolved.hostname, finalUrl)) continue;
    if (!ROOT_PATHS.has(resolved.pathname.toLowerCase())) continue;
    if (resolved.search) continue;
    return true;
  }

  return false;
}

function brandCandidates(snapshot: DomSnapshot): Set<string> {
  const candidates = new Set<string>();
  const siteName = snapshot.meta.og_site_name;
  if (siteName && siteName.trim()) candidates.add(siteName.trim().toLowerCase());

  // Titles are commonly "Brand | Tagline"; both ends are plausible brand text.
  const parts = (snapshot.title || "")
    .split(/[|·—–]|\s-\s/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0 && part.length <= 40);
  if (parts.length > 1) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first) candidates.add(first.toLowerCase());
    if (last) candidates.add(last.toLowerCase());
  }

  return candidates;
}

/* -------------------------------- helpers -------------------------------- */

function isExternal(href: string | null, finalUrl: string): boolean {
  const resolved = resolve(href, finalUrl);
  if (!resolved || !isHttp(resolved)) return false;
  return !sameSite(resolved.hostname, finalUrl);
}

function resolve(href: string | null, finalUrl: string): URL | null {
  const raw = (href || "").trim();
  if (!raw || raw.startsWith("#")) return null;
  try {
    return new URL(raw, finalUrl);
  } catch {
    return null;
  }
}

function isHttp(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function sameSite(host: string, finalUrl: string): boolean {
  try {
    return registrableHost(host) === registrableHost(new URL(finalUrl).hostname);
  } catch {
    return false;
  }
}

function trim(text: string, limit = NAV_TEXT_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}
