import type { PageRecord, ScriptRecord, TrackingSignal } from "../types/index.js";

interface VendorRule {
  vendor: string;
  kind: TrackingSignal["kind"];
  host?: RegExp;
  inline?: RegExp;
  global?: RegExp;
}

const VENDORS: VendorRule[] = [
  { vendor: "Meta Pixel", kind: "pixel", host: /connect\.facebook\.net/i, inline: /fbq\s*\(/i, global: /^fbq$/ },
  { vendor: "Google Tag Manager", kind: "tag_manager", host: /googletagmanager\.com\/gtm\.js/i, inline: /GTM-[A-Z0-9]+/, global: /^dataLayer$/ },
  { vendor: "Google Analytics 4", kind: "analytics", host: /googletagmanager\.com\/gtag\/js/i, inline: /gtag\s*\(\s*['"]config/i, global: /^gtag$/ },
  { vendor: "Google Analytics (Universal)", kind: "analytics", host: /google-analytics\.com\/analytics\.js/i, inline: /ga\s*\(\s*['"]create/i, global: /^_?gaq?$/ },
  { vendor: "Google Ads Conversion", kind: "pixel", inline: /AW-\d{6,}/ },
  { vendor: "TikTok Pixel", kind: "pixel", host: /analytics\.tiktok\.com/i, inline: /ttq\./i, global: /^ttq$/ },
  { vendor: "X (Twitter) Pixel", kind: "pixel", host: /static\.ads-twitter\.com/i, global: /^twq$/ },
  { vendor: "Snap Pixel", kind: "pixel", host: /sc-static\.net\/scevent/i, global: /^snaptr$/ },
  { vendor: "Pinterest Tag", kind: "pixel", host: /s\.pinimg\.com\/ct/i, global: /^pintrk$/ },
  { vendor: "LinkedIn Insight", kind: "pixel", host: /snap\.licdn\.com/i, global: /^lintrk$/ },
  { vendor: "Reddit Pixel", kind: "pixel", host: /redditstatic\.com\/ads/i, global: /^rdt$/ },
  { vendor: "Hotjar", kind: "heatmap", host: /static\.hotjar\.com/i, global: /^hj$/ },
  { vendor: "Microsoft Clarity", kind: "heatmap", host: /clarity\.ms/i, global: /^clarity$/ },
  { vendor: "Segment", kind: "analytics", host: /cdn\.segment\.com/i, global: /^analytics$/ },
  { vendor: "PostHog", kind: "analytics", host: /posthog\.com/i, global: /^posthog$/ },
  { vendor: "Mixpanel", kind: "analytics", host: /cdn\.mxpnl\.com/i, global: /^mixpanel$/ },
  { vendor: "Amplitude", kind: "analytics", host: /amplitude\.com/i, global: /^amplitude$/ },
  { vendor: "Klaviyo", kind: "analytics", host: /static\.klaviyo\.com/i, global: /^_learnq$/ },
  { vendor: "Intercom", kind: "chat", host: /widget\.intercom\.io/i, global: /^Intercom$/ },
  { vendor: "Drift", kind: "chat", host: /js\.driftt\.com/i, global: /^drift$/ },
  { vendor: "Crisp", kind: "chat", host: /client\.crisp\.chat/i, global: /^\$crisp$/ },
  { vendor: "Tidio", kind: "chat", host: /code\.tidio\.co/i, global: /^tidioChatApi$/ },
  { vendor: "Hyros", kind: "pixel", host: /hyros\.com|t\.hyros/i },
  { vendor: "Wicked Reports", kind: "pixel", host: /wickedreports\.com/i },
  { vendor: "Triple Whale", kind: "analytics", host: /triplewhale\.com/i },
  { vendor: "HubSpot", kind: "analytics", host: /js\.hs-scripts\.com|js\.hsforms\.net/i },
  { vendor: "Cloudflare Web Analytics", kind: "analytics", host: /static\.cloudflareinsights\.com|cloudflareinsights\.com\/beacon/i },
  { vendor: "Plausible", kind: "analytics", host: /plausible\.io\/js/i },
  { vendor: "Fathom", kind: "analytics", host: /cdn\.usefathom\.com/i },
  { vendor: "Matomo", kind: "analytics", host: /matomo\.(cloud|org)|piwik/i, global: /^_paq$/ },
  { vendor: "Vercel Analytics", kind: "analytics", host: /\/_vercel\/insights/i },
  // A funnel/CRM runtime, not an analytics product: recorded so the payload
  // shows what the page loads, without claiming the page has analytics.
  { vendor: "GoHighLevel", kind: "other", host: /leadconnectorhq\.com|msgsndr\.com/i },
];

export function detectTracking(record: PageRecord): TrackingSignal[] {
  const technical = record.technical_snapshot;
  const scripts: ScriptRecord[] = technical?.scripts || [];
  const globals = technical?.tracking_globals || [];
  const signals: TrackingSignal[] = [];
  const seen = new Set<string>();

  const push = (vendor: string, kind: TrackingSignal["kind"], evidence: string) => {
    if (seen.has(vendor)) return;
    seen.add(vendor);
    signals.push({ vendor, kind, evidence });
  };

  for (const rule of VENDORS) {
    const byHost = rule.host
      ? scripts.find((script) => (script.src && rule.host!.test(script.src)) || (script.host && rule.host!.test(script.host)))
      : undefined;
    if (byHost) {
      push(rule.vendor, rule.kind, `script ${byHost.src ?? byHost.host ?? ""}`);
      continue;
    }
    const byInline = rule.inline
      ? scripts.find((script) => script.inline_snippet && rule.inline!.test(script.inline_snippet))
      : undefined;
    if (byInline) {
      push(rule.vendor, rule.kind, `inline script matches ${rule.inline}`);
      continue;
    }
    const byGlobal = rule.global ? globals.find((name) => rule.global!.test(name)) : undefined;
    if (byGlobal) push(rule.vendor, rule.kind, `window.${byGlobal} is defined`);
  }

  return signals;
}

export function thirdPartyHosts(record: PageRecord): string[] {
  const scripts = record.technical_snapshot?.scripts || [];
  let pageHost: string | null = null;
  try {
    pageHost = new URL(record.url).hostname;
  } catch {
    pageHost = null;
  }
  const hosts = new Set<string>();
  for (const script of scripts) {
    if (!script.host) continue;
    if (pageHost && script.host === pageHost) continue;
    hosts.add(script.host);
  }
  return [...hosts].sort();
}
