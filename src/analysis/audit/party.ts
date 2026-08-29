import { registrableHost } from "../registrable_host.js";
import type { EventParty, TechnicalEventClassification } from "../landing_types.js";

/**
 * Security and bot-mitigation infrastructure. These endpoints fail, retry and
 * log noisily by design — a Turnstile challenge that retries says nothing about
 * whether the funnel works.
 */
const SECURITY_HOSTS =
  /(^|\.)challenges\.cloudflare\.com$|(^|\.)hcaptcha\.com$|(^|\.)recaptcha\.net$|(^|\.)gstatic\.com$|(^|\.)google\.com$|(^|\.)arkoselabs\.com$|(^|\.)perimeterx\.net$|(^|\.)px-cloud\.net$|(^|\.)datadome\.co$|(^|\.)funcaptcha\.com$|turnstile/i;

const ANALYTICS_HOSTS =
  /(^|\.)google-analytics\.com$|(^|\.)googletagmanager\.com$|(^|\.)analytics\.google\.com$|(^|\.)doubleclick\.net$|(^|\.)facebook\.(com|net)$|(^|\.)connect\.facebook\.net$|(^|\.)tiktok\.com$|(^|\.)analytics\.tiktok\.com$|(^|\.)snap\.licdn\.com$|(^|\.)linkedin\.com$|(^|\.)hotjar\.(com|io)$|(^|\.)clarity\.ms$|(^|\.)segment\.(io|com)$|(^|\.)mixpanel\.com$|(^|\.)amplitude\.com$|(^|\.)posthog\.com$|(^|\.)cloudflareinsights\.com$|(^|\.)plausible\.io$|(^|\.)matomo\.cloud$|(^|\.)sentry\.io$|(^|\.)bugsnag\.com$/i;

/** Chromium's own messages, not the page's code. */
const BROWSER_NOISE =
  /third-party cookie|will be blocked|is deprecated|Deprecation|violates the following Content Security Policy|was preloaded using link preload|Failed to load resource: net::ERR_(BLOCKED_BY_CLIENT|CACHE)|Slow network is detected|favicon/i;

export function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Where an event came from, relative to the page being analysed. The audit
 * engine uses this to keep somebody else's infrastructure out of the funnel's
 * scorecard.
 */
export function classifyParty(sourceUrl: string | null, pageUrl: string, text?: string): TechnicalEventClassification {
  const host = hostFromUrl(sourceUrl);
  const pageHost = hostFromUrl(pageUrl);

  if (!host) {
    // No source URL: only the message itself can place it.
    if (text && BROWSER_NOISE.test(text)) return { party: "browser", host: null, vendor: null };
    return { party: "unknown", host: null, vendor: null };
  }

  if (SECURITY_HOSTS.test(host)) {
    return { party: "security_infrastructure", host, vendor: vendorFor(host) };
  }
  if (ANALYTICS_HOSTS.test(host)) {
    return { party: "analytics", host, vendor: vendorFor(host) };
  }
  if (pageHost && registrableHost(host) === registrableHost(pageHost)) {
    return { party: "first_party", host, vendor: null };
  }
  if (text && BROWSER_NOISE.test(text)) return { party: "browser", host, vendor: null };

  return { party: "third_party", host, vendor: vendorFor(host) };
}

function vendorFor(host: string): string | null {
  const root = registrableHost(host);
  if (/cloudflare\.com$/.test(root)) return /challenges\./.test(host) ? "Cloudflare Turnstile" : "Cloudflare";
  if (/cloudflareinsights\.com$/.test(root)) return "Cloudflare Web Analytics";
  if (/hcaptcha\.com$/.test(root)) return "hCaptcha";
  if (/recaptcha\.net$|google\.com$|gstatic\.com$/.test(root)) return "Google reCAPTCHA";
  if (/googletagmanager\.com$/.test(root)) return "Google Tag Manager";
  if (/google-analytics\.com$/.test(root)) return "Google Analytics";
  if (/facebook\.(com|net)$/.test(root)) return "Meta";
  return null;
}

/** Only first-party failures can be blamed on the funnel's own build. */
export function isFirstParty(party: EventParty): boolean {
  return party === "first_party";
}
