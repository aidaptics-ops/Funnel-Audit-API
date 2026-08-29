import { existsSync } from "node:fs";
import { join } from "node:path";

export function siteSlugFromUrl(startUrl: string): string {
  try {
    const url = new URL(startUrl);
    if (url.protocol === "file:") {
      const file = url.pathname.split(/[/\\]/).filter(Boolean).pop() || "local-page";
      return `local_${safe(file.replace(/\.[^.]+$/, "")) || "page"}`;
    }
    const host = url.hostname.replace(/^www\./, "").replace(/\./g, "-");
    const pathParts = url.pathname
      .split("/")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => safe(decodeURIComponent(part)))
      .filter(Boolean);
    return pathParts.length ? `${host}_${pathParts.join("_")}` : host || "funnel";
  } catch {
    return "funnel";
  }
}

/**
 * Stable identifier for a funnel across runs: same URL (ignoring tracking
 * params) always produces the same id, so runs can be grouped downstream.
 */
export function funnelIdFromUrl(startUrl: string): string {
  return siteSlugFromUrl(startUrl);
}

export function timestampSlug(at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}_${pad(at.getHours())}${pad(at.getMinutes())}`;
}

export function makeCrawlId(startUrl: string, at = new Date()): string {
  return `${siteSlugFromUrl(startUrl)}_${timestampSlug(at)}`;
}

export function uniqueCrawlId(
  startUrl: string,
  dirs: string[],
  at = new Date(),
): string {
  const base = makeCrawlId(startUrl, at);
  let candidate = base;
  let n = 2;
  while (dirs.some((dir) => taken(dir, candidate))) {
    candidate = `${base}_${n}`;
    n += 1;
  }
  return candidate;
}

function taken(dir: string, id: string): boolean {
  return existsSync(join(dir, `${id}.json`)) || existsSync(join(dir, id));
}

function safe(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
