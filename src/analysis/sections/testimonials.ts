import type { CaptureResult } from "../../pipeline/capture.js";
import type { DomSnapshot, TestimonialRecord, TextBlock } from "../../types/index.js";
import type { TestimonialEntry } from "../landing_types.js";

/** Leading quote/dash decoration that precedes an attribution line. */
const ATTRIBUTION_LEAD = /^[\s"'“”‘’\-–—•·]+/;
const ATTRIBUTION_TRAIL = /[\s.,;:"'“”]+$/;

/** First separator that splits "Name, rest" / "Name | rest" / "Name - rest". */
const NAME_SEPARATOR = /\s*(?:,|\||–|—|·|•|\s-\s|\/)\s*/;

const PERSON_NAME = /^[\p{Lu}][\p{L}'’.-]*(?:\s+[\p{L}'’.-]+){0,3}$/u;

const ROLE_WORD =
  /\b(ceo|cto|coo|cfo|cmo|cro|founder|co-?founder|owner|president|vice[- ]president|vp|director|managing director|manager|head of|team lead|lead|principal|partner|consultant|coach|trainer|instructor|author|speaker|engineer|designer|developer|marketer|attorney|lawyer|dr\.?|doctor|physician|dentist|surgeon|nurse|therapist|teacher|professor|student|realtor|real estate agent|agent|advisor|adviser|analyst|strategist|specialist|chef|photographer|videographer|producer|editor|entrepreneur|investor|creator|operator|freelancer|accountant|architect|nutritionist|dietitian|recruiter|scientist|officer|chair(?:man|woman|person)?|executive|manager|associate|supervisor|technician|paramedic|firefighter|pilot|barber|stylist|athlete|parent|mom|dad|mother|father)\b/i;

const COMPANY_WORD =
  /\b(inc\.?|llc|l\.l\.c\.|ltd\.?|limited|corp\.?|corporation|company|co\.|group|agency|media|labs?|studios?|solutions|systems|technologies|technology|ventures|capital|partners|consulting|holdings|fitness|clinic|academy|institute|university|college|foundation|collective|worldwide|international|global)\b/i;

const DATE_SLASH = /\d{1,4}\s*\/\s*\d{1,2}\s*\/\s*\d{1,4}/;
const RATING_SLASH = /(\d(?:\.\d)?)\s*\/\s*5(?!\d)/;
const RATING_OUT_OF = /(\d(?:\.\d)?)\s*(?:out of|of)\s*5(?!\d)/i;
const RATING_STARS = /\b(\d(?:\.\d)?)[\s-]*stars?\b/i;
const STAR_GLYPHS = /[★☆⭐✪✭✮✯]{4,5}/;

/**
 * Maps the already-detected testimonial records onto the response shape and
 * adds the attribution details that are readable from the surrounding text.
 * Nothing here judges authenticity; it only reports what is on the page.
 */
export function buildTestimonials(capture: CaptureResult): TestimonialEntry[] {
  const snapshot = capture.snapshot;
  const reviewBodies = schemaReviewBodies(snapshot.json_ld);

  return capture.record.testimonials.map((record, index) => {
    const attribution = findAttribution(snapshot, record);
    return {
      index,
      text: record.text.trim(),
      name: record.name ?? attribution?.name ?? null,
      role: attribution?.role ?? null,
      company: attribution?.company ?? null,
      rating: findRating(snapshot, record),
      result_claim: record.claimed_result,
      format: record.format,
      above_fold: record.position === "above_fold",
      y: record.y,
      source: matchesSchemaReview(record.text, reviewBodies) ? "schema" : "page_text",
    };
  });
}

interface Attribution {
  name: string | null;
  role: string | null;
  company: string | null;
}

/**
 * An attribution must be a short line that sits with the quote: either the tail
 * of the quote itself after a dash, or a short block just below it. Anything
 * that does not parse into a name plus a role/company shape is discarded.
 */
function findAttribution(snapshot: DomSnapshot, record: TestimonialRecord): Attribution | null {
  const tail = trailingAttribution(record.text);
  if (tail) {
    const parsed = parseAttribution(tail);
    if (parsed) return parsed;
  }

  const candidates = snapshot.paragraphs
    .filter(
      (p) =>
        p.y >= record.y &&
        p.y <= record.y + 120 &&
        p.text.trim() !== record.text.trim() &&
        p.text.trim().length <= 120,
    )
    .sort((a, b) => a.y - b.y);

  for (const candidate of candidates) {
    const parsed = parseAttribution(candidate.text);
    if (parsed) return parsed;
  }
  return null;
}

/** "...worth every penny. — Jane Doe, CEO of Acme" -> "Jane Doe, CEO of Acme" */
function trailingAttribution(text: string): string | null {
  const match = text.match(/[–—]\s*([^–—]{4,90})$/);
  const tail = match?.[1]?.trim();
  return tail && tail.length <= 90 ? tail : null;
}

function parseAttribution(raw: string): Attribution | null {
  const line = raw.replace(ATTRIBUTION_LEAD, "").replace(ATTRIBUTION_TRAIL, "").trim();
  if (!line || line.length > 120) return null;

  const separator = line.match(NAME_SEPARATOR);
  if (!separator || separator.index === undefined) return null;

  const namePart = line.slice(0, separator.index).trim();
  const rest = line.slice(separator.index + separator[0].length).trim();
  if (!namePart || !rest || rest.length > 90) return null;
  if (!PERSON_NAME.test(namePart) || namePart.length > 48) return null;

  const roleAndCompany = splitRoleCompany(rest);
  if (!roleAndCompany) return null;
  return { name: namePart, ...roleAndCompany };
}

function splitRoleCompany(rest: string): { role: string | null; company: string | null } | null {
  const joined = rest.match(/^(.{2,60}?)\s+(?:of|at|with|for|@)\s+(.{2,60})$/i);
  if (joined && ROLE_WORD.test(joined[1] as string) && looksLikeCompany(joined[2] as string)) {
    return { role: (joined[1] as string).trim(), company: (joined[2] as string).trim() };
  }

  const nested = rest.match(/^([^,|]{2,60})\s*[,|]\s*(.{2,60})$/);
  if (nested && ROLE_WORD.test(nested[1] as string) && looksLikeCompany(nested[2] as string)) {
    return { role: (nested[1] as string).trim(), company: (nested[2] as string).trim() };
  }

  if (ROLE_WORD.test(rest)) return { role: rest, company: null };
  if (COMPANY_WORD.test(rest)) return { role: null, company: rest };
  return null;
}

/** A company name here is a short, capitalised phrase, not a sentence. */
function looksLikeCompany(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 60) return false;
  if (trimmed.split(/\s+/).length > 6) return false;
  if (!/^[\p{Lu}\p{N}]/u.test(trimmed)) return false;
  return !/[.!?]/.test(trimmed) || COMPANY_WORD.test(trimmed);
}

function findRating(snapshot: DomSnapshot, record: TestimonialRecord): number | null {
  const direct = ratingIn(record.text);
  if (direct !== null) return direct;

  const nearby: TextBlock[] = snapshot.paragraphs.filter(
    (p) =>
      p.y >= record.y - 80 &&
      p.y <= record.y + 120 &&
      p.text.trim() !== record.text.trim() &&
      // A rating label sits in its own tiny block; long prose nearby belongs to
      // some other element and must not be attached to this quote.
      p.text.trim().length <= 80,
  );

  for (const block of nearby) {
    const value = ratingIn(block.text);
    if (value !== null) return value;
  }
  return null;
}

function ratingIn(text: string): number | null {
  const glyphs = text.match(STAR_GLYPHS);
  if (glyphs) return clampRating(glyphs[0].length);

  if (!DATE_SLASH.test(text)) {
    const slash = text.match(RATING_SLASH);
    if (slash) return clampRating(Number(slash[1]));
  }

  const outOf = text.match(RATING_OUT_OF);
  if (outOf) return clampRating(Number(outOf[1]));

  const stars = text.match(RATING_STARS);
  if (stars) return clampRating(Number(stars[1]));

  return null;
}

function clampRating(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value < 1 || value > 5) return null;
  return value;
}

function schemaReviewBodies(jsonLd: unknown[]): string[] {
  const bodies: string[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const record = node as Record<string, unknown>;
    for (const key of ["reviewBody", "description"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 20 && isReviewNode(record, key)) {
        bodies.push(normalize(value));
      }
    }
    for (const value of Object.values(record)) walk(value);
  };

  walk(jsonLd);
  return bodies;
}

/** "description" only counts when the node itself is declared a Review. */
function isReviewNode(record: Record<string, unknown>, key: string): boolean {
  if (key === "reviewBody") return true;
  const type = record["@type"];
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === "string" && /review|testimonial/i.test(t));
}

function matchesSchemaReview(text: string, bodies: string[]): boolean {
  if (!bodies.length) return false;
  const normalized = normalize(text);
  const probe = normalized.slice(0, 60);
  if (probe.length < 20) return false;
  return bodies.some((body) => body.includes(probe) || normalized.includes(body.slice(0, 60)));
}

function normalize(value: string): string {
  return value
    .replace(/[“”‘’"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
