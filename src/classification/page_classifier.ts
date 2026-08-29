import type {
  ClassificationResult,
  CtaRecord,
  DomSnapshot,
  FormRecord,
  PageType,
  VideoRecord,
} from "../types/index.js";

interface Signals {
  snapshot: DomSnapshot;
  forms: FormRecord[];
  videos: VideoRecord[];
  ctas: CtaRecord[];
}

interface Score {
  type: PageType;
  score: number;
  evidence: string[];
}

export function classifyPage(input: Signals): ClassificationResult {
  const scores = scorePage(input);
  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const second = scores[1];

  if (!top || top.score <= 0) {
    return { page_type: "unknown", confidence: 0.2, evidence: ["no strong classification signals"] };
  }

  const margin = top.score - (second?.score || 0);
  const confidence = Math.max(0.35, Math.min(0.95, 0.45 + top.score / 12 + margin / 20));

  return {
    page_type: top.type,
    confidence: Number(confidence.toFixed(2)),
    evidence: top.evidence.slice(0, 8),
  };
}

export function scorePage(input: Signals): Score[] {
  const { snapshot, forms, videos, ctas } = input;
  const text = `${snapshot.title}\n${snapshot.meta.description || ""}\n${snapshot.visible_text}`.toLowerCase();
  const url = snapshot.url.toLowerCase();
  const scores: Score[] = [];

  const add = (type: PageType, scored: [number, string[]]) => {
    if (scored[0] > 0) scores.push({ type, score: scored[0], evidence: scored[1] });
  };

  const webinarForm = forms.some(
    (f) => f.type === "webinar_registration" || (f.visible && f.field_count <= 5 && f.fields.some((x) => x.purpose === "email")),
  );
  add("webinar_registration", sum([
    hit(text, /\bwebinar\b/, 3, "webinar language detected"),
    hit(text, /\b(masterclass|workshop|live (training|session|event))\b/, 2, "live event language detected"),
    hit(text, /\b(register|save (my )?spot|reserve (your )?seat)\b/, 2, "registration language detected"),
    hit(text, /\b(date|today|tomorrow|\d{1,2}:\d{2}|am|pm|est|pst)\b/, 1, "date/time information detected"),
    webinarForm ? [2, "registration form detected"] : [0, ""],
    hit(url, /webinar|register|workshop/, 2, "URL suggests registration"),
  ]));

  add("optin", sum([
    forms.some((f) => f.type === "optin") ? [3, "opt-in form detected"] : [0, ""],
    hit(text, /\b(free (guide|pdf|checklist|download|training)|opt[- ]?in|subscribe)\b/, 2, "lead-magnet language detected"),
    forms.some((f) => f.field_count <= 4 && f.fields.some((x) => x.purpose === "email")) &&
    !/\bwebinar\b/.test(text)
      ? [2, "short email capture form detected"]
      : [0, ""],
  ]));

  const visibleVideo = videos.filter((v) => v.visible);
  add("vsl", sum([
    visibleVideo.length ? [3, `${visibleVideo.length} visible video(s) detected`] : [0, ""],
    visibleVideo.some((v) => v.position === "above_fold") ? [2, "video is above the fold"] : [0, ""],
    hit(text, /\b(watch|video sales|vsl|press play)\b/, 2, "watch/video language detected"),
    ctas.some((c) => /apply|book|buy|get started/i.test(c.text)) ? [1, "sales CTA near video"] : [0, ""],
  ]));

  const appForm = forms.find((f) => f.type === "application");
  const typeformIframe = snapshot.iframes.some((f) => /typeform/i.test(f.src || ""));
  const appInView =
    (appForm && appForm.position === "above_fold") ||
    snapshot.iframes.some((f) => /typeform/i.test(f.src || "") && f.position === "above_fold");
  add("application", sum([
    appForm ? [appInView ? 5 : 2, "application form detected"] : [0, ""],
    typeformIframe ? [appInView ? 3 : 1, "Typeform embed detected"] : [0, ""],
    hit(text, /\b(apply|application|qualify|discovery form)\b/, 2, "application language detected"),
    forms.some((f) => f.field_count >= 6) ? [2, "long form detected"] : [0, ""],
    hit(url, /apply|application/, 2, "URL suggests application"),
  ]));

  add("booking", sum([
    hit(url, /calendly|cal\.com|acuity|tidycal|hubspot\.com\/meetings/, 4, "calendar provider URL detected"),
    snapshot.iframes.some((f) => /calendly|cal\.com|acuity|tidycal/i.test(f.src || ""))
      ? [4, "calendar iframe detected"]
      : [0, ""],
    hit(text, /\b(book (a |your )?(call|demo|session)|pick a time|schedule|select a date)\b/, 2, "booking language detected"),
  ]));

  add("calendar", sum([
    snapshot.iframes.some((f) => /calendly|calendar|cal\.com/i.test(f.src || ""))
      ? [3, "calendar iframe detected"]
      : [0, ""],
    hit(text, /\b(available times?|time zone|30 min|15 min|60 min)\b/, 2, "time-slot language detected"),
  ]));

  add("checkout", sum([
    forms.some((f) => f.type === "checkout") ? [4, "checkout form detected"] : [0, ""],
    hit(text, /\b(order summary|credit card|pay now|complete (my |your )?purchase|cart)\b/, 3, "checkout language detected"),
    hit(url, /checkout|cart|thrivecart|samcart|stripe/, 3, "checkout URL detected"),
  ]));

  add("one_time_offer", sum([
    hit(text, /\bone[- ]time (offer|only)\b/, 4, "one-time offer language detected"),
    hit(text, /\b(wait[!]|special offer|yes[, ]i want|no thanks|decline this offer)\b/, 3, "OTO choice language detected"),
    hit(url, /oto|upsell|offer/, 2, "URL suggests offer"),
  ]));

  add("confirmation", sum([
    hit(text, /\b(you('re| are) (in|registered|confirmed)|spot (is )?reserved|check your (email|inbox))\b/, 4, "confirmation message detected"),
    hit(text, /\b(add to calendar|next steps?|watch this next)\b/, 2, "next-step confirmation language"),
    hit(url, /confirm|thanks|success|registered/, 2, "URL suggests confirmation"),
  ]));

  add("thank_you", sum([
    hit(text, /\bthank you\b/, 3, "thank-you language detected"),
    hit(url, /thank|thanks|order-complete/, 2, "URL suggests thank-you"),
    hit(text, /\b(order (received|confirmed)|purchase complete)\b/, 2, "order confirmation language"),
  ]));

  add("training", sum([
    hit(text, /\b(module|lesson|training portal|watch the training|course dashboard)\b/, 3, "training language detected"),
    hit(url, /members|lesson|module|training|classroom/, 2, "URL suggests training"),
  ]));

  add("community", sum([
    hit(url, /facebook\.com\/groups|skool\.com|circle\.so|discord\.gg|community/, 4, "community URL detected"),
    hit(text, /\b(join the (facebook )?group|community|skool|circle)\b/, 2, "community language detected"),
  ]));

  add("login", sum([
    forms.some((f) => f.type === "login") ? [4, "login form detected"] : [0, ""],
    hit(text, /\b(log in|sign in|password)\b/, 2, "login language detected"),
    hit(url, /login|signin|sign-in/, 2, "URL suggests login"),
  ]));

  add("sales_page", sum([
    hit(text, /\b(buy now|enroll|guarantee|what you('ll| will) get)\b/, 2, "sales language detected"),
    snapshot.paragraphs.length > 20 ? [1, "long-form page structure"] : [0, ""],
    ctas.some((c) => /buy|enroll|get access|add to cart/i.test(c.text)) ? [2, "purchase CTA detected"] : [0, ""],
  ]));

  return scores;
}

function hit(text: string, re: RegExp, weight: number, evidence: string): [number, string] {
  return re.test(text) ? [weight, evidence] : [0, ""];
}

function sum(parts: Array<[number, string]>): [number, string[]] {
  const evidence = parts.filter((p) => p[0] > 0 && p[1]).map((p) => p[1]);
  const score = parts.reduce((acc, p) => acc + p[0], 0);
  return [score, evidence];
}
