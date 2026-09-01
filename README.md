# Landing Page Analysis API

Give it a funnel URL. It loads the landing page once with Playwright and returns a deeply structured,
evidence-backed analysis of everything that can actually be detected on that page.

It does **not** fill forms, submit forms, interact with Typeform, touch Calendly, book anything, or crawl
confirmation pages. Forms and scheduler integrations are **detected and documented, never interacted with**.

Accuracy is the product. Every value is traceable to something observed on the page, and anything that
cannot be established is returned as `{"status": "unknown", "reason": "..."}` rather than guessed.

## Run it

```bash
npm install
npm run serve                      # http://localhost:3000
curl -s localhost:3000/health
curl -s -X POST localhost:3000/analyze -H 'content-type: application/json' \
  -d '{"url":"https://example.com/offer"}' | jq .
```

Analyse a single URL without the HTTP layer:

```bash
npm run analyze -- https://example.com/offer
```

## Docker

```bash
docker build -t funnel-analyzer .
docker run -p 3000:3000 funnel-analyzer
```

The image is based on `mcr.microsoft.com/playwright:v1.62.1-noble`, so Chromium and its OS dependencies
ship with it — nothing is installed at runtime. `docker-compose.yml` is there for local work (it sets
`shm_size: 1gb`, without which Chromium crashes on large pages).

### Render

Deploy as a **Docker Web Service**. Render sets `PORT`; the server binds `0.0.0.0:$PORT`. Point the health
check at `/health` — it answers without touching the browser, so it stays green while an analysis is running.

## Endpoints

### `POST /analyze`

```json
{ "url": "https://example.com/funnel", "screenshot": false, "capture_profile": "full" }
```

`url` is the only required field.

| Field | Default | Meaning |
| --- | --- | --- |
| `screenshot` | `false` | Also return strips of the rendered page, for a vision model |
| `capture_profile` | `"full"` | `"full"` runs the whole audit; `"light"` keeps the evidence and drops the checks a downstream page does not need |

`capture_profile: "light"` is page-agnostic — it changes how hard the crawler works, never what it
concludes. It switches off the second mobile-viewport pass, switches off link checking, and caps the
screenshot at 3 strips. Use it for the second and third page of a funnel, where the question is what the
page *is* rather than how well it converts. An unrecognised value is treated as `"full"`, never an error.

```json
{
  "status": "completed",
  "job_id": "3f1c…",
  "url": "https://example.com/funnel",
  "analysis": { "funnel": {}, "page": {}, "hero": {} }
}
```

Failures use the same envelope:

```json
{ "status": "failed", "job_id": "…", "url": "…", "error": { "code": "private_host", "message": "…" } }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `invalid_url`, `unsupported_scheme`, `private_host`, `credentials_not_allowed`, `url_too_long`, `invalid_body`, `dns_resolution_failed` | 400 | Rejected before a browser was touched |
| `too_many_requests` | 429 | All analysis slots were busy for longer than the queue wait |
| `analysis_timeout` | 408 | The analysis exceeded `ANALYSIS_TIMEOUT_MS` |
| `navigation_failed` | 502 | The target page could not be loaded |
| `internal_error` | 500 | Anything else (details are logged, never returned) |

### `GET /health`

```json
{ "status": "ok", "version": "1.0.0", "uptime_s": 42, "active_analyses": 0, "queued_analyses": 0 }
```

## The analysis object

One page, twenty-two sections, all built from a single render:

| Section | What it holds |
| --- | --- |
| `funnel` | requested/final URL, domain, redirect chain, funnel type, brand name, primary conversion goal, and a `business_identity` block (emails, phones, socials, org names) for a **separate** enrichment service |
| `page` | title, meta, canonical, language, status, dimensions, timings, visible text, DOM counts, page sections |
| `hero` | above-the-fold headline, subheadline, supporting copy, primary/secondary CTAs, offer, trust elements, hero media, value-proposition determination |
| `headings` | the full heading hierarchy with level, visibility and fold position |
| `copy` | word counts, measurable style facts, key messages, repeated messages, benefits, objection handling, FAQ, provable inconsistencies |
| `videos` | every detected player: provider, id, geometry, autoplay/muted/controls, duration when exposed |
| `vsl` | whether the page is built around a sales video, with the indicators that decided it |
| `ctas` | every CTA with type, destination classification, fold position and which one is primary |
| `forms` | every form and form-shaped integration — provider, integration type, fields where visible, `"interacted": false` |
| `testimonials` | quotes with name/role/company/rating **only where an attribution is genuinely present** |
| `social_proof` | logos, media mentions, numeric claims, ratings, authority indicators, trust badges, case studies |
| `offer` | product, audience, mechanism, benefits, deliverables, bonuses, prices, risk reversal, CTA relationship, clarity |
| `guarantees` | guarantee sentences with kind and duration |
| `pricing` | prices, original prices, discounts, payment plans, currency |
| `urgency` | countdown timers, deadlines, scarcity claims, and how strong the evidence actually is |
| `navigation` | nav and footer items, exit links above the fold |
| `links` | internal/external/social/mailto/tel breakdown plus real link-check results |
| `tracking` | detected vendors with IDs, and explicit statements phrased about the **rendered page** |
| `seo` | title, meta, canonical, robots, H1s, heading structure, OG/Twitter, structured data, image alt coverage |
| `technical` | HTTPS, redirects, console errors, failed requests, broken images, iframes, third-party scripts, mobile observations |
| `summary` | cross-section counts, primary CTA, CTA consistency, issue totals |
| `observed_issues` | evidence-backed findings only |
| `raw_evidence` | everything observed, before anything decided what it meant — see below |

### `raw_evidence`: what was seen, not what it means

Every other section is a judgement, and a judgement throws away the evidence it was made from. That is
fine while the question is one this service already knows to ask, and useless the moment it is not —
nothing in here has heard of the page builder that ships next month.

`raw_evidence` is deliberately viewless. It carries the rendered HTML (head verbatim, body as a skeleton
with script/style bodies, long `data:` URIs and the values of hidden/password/email/tel inputs elided,
plus a sha256 of the *whole* document), the page title and URL chain, every `<meta>` and `<link rel>`, the
visible text, headings, paragraphs, links, buttons, images with their attributes, scripts with their hosts
and inline snippets, every iframe/embed/object with its raw host, the JSON-LD, the vendor globals found on
`window`, console and page errors, failed requests, and the viewport.

Its `images` are **unfiltered**: the judged sections read a list with everything under 20px square removed,
because a tracking pixel counted as a visible image arrives as a missing alt and a spacer gif that never
loads arrives as a broken image. Here every `<img>` is kept, each carrying `meets_size_threshold` so a
reader can tell which side of that line it fell on.

Its `forms` array is **unfiltered** too: the search box and the login form that the judged `forms` section
drops are all here, each with its action and action host, method, name/id, every field
(tag/type/name/id/placeholder/label/required/autocomplete/options), its hidden inputs, its submit text and
the raw host of any iframe embedded inside it.

A document-wide `hidden_inputs` sits beside `forms`, naming each input's owning form (`null` for one that
belongs to no form). The per-form copies are a convenience view and cannot carry an input that sits outside
every form — the ledger counts the document-wide collection, so this is the field its row describes.

No hidden input's **value** is ever reported, in any field: a hidden input routinely carries a CSRF token, a
session id or a prefilled email address, and only `value_present` is evidence.

Nothing here is labelled. A `calendly.com` iframe is reported as a host and a `window.Calendly` global as a
name; concluding "this is a booking page" is the reader's job, not the crawler's.

#### Declared incompleteness

Every collection that a cap or a filter could shorten ships as:

```json
{ "items": [], "total": 412, "truncated": true, "cap": 300 }
```

and every collector also records a row in `raw_evidence.completeness`:

```json
{ "field": "meta_all", "captured": 300, "total": 412, "complete": false, "cap": 300 }
```

This exists because a truncated list and an empty page are indistinguishable once the evidence leaves the
process — `"links": []` reads as "the page has no links" whether that is true or whether the cap ate them.
**A reader may only conclude "there is no X on this page" over a field the ledger marks `complete`.** A
few rows can never read complete by design: `window_globals_present` counts vendor names found against
every global the page defines, so a name probe can never certify that no third-party service is present.
Caps inside a record are declared the same way — `forms.fields.options` counts the choices kept across
every `<select>` against every choice the page offered, because a country list cut at 50 with nothing
saying so reads as a checkout that does not ship where the reader asked.

### How uncertainty is expressed

```json
"funnel_type": { "status": "detected", "value": "vsl", "confidence": 0.72,
                 "evidence": ["classifier: vsl (0.8)", "video above the fold", "3 CTAs pointing at one form"] }
"audience":    { "status": "unknown", "reason": "No explicit audience statement was found in the copy" }
```

There is no `predicted_issues` field. Prediction belongs in a later layer that consumes this output.

### Observed issues

```json
{
  "id": "NO_CTA_ABOVE_FOLD",
  "severity": "low",
  "category": "cta",
  "title": "No call to action appears within the first viewport",
  "description": "The conversion form is inside the first viewport, but its submit control sits below the 900px fold.",
  "evidence": [
    "1 CTA(s) detected, none within the 900px fold",
    "Highest CTA \"SUBMIT\" (the form's own submit control) sits at y=1041px",
    "A 5-field form starts at y=595px, inside the fold"
  ],
  "impact": "The application funnel's conversion path does start above the fold, so this is a refinement rather than a blocker.",
  "severity_rationale": "Downgraded from high: the form itself is above the fold.",
  "recommendation": "Optional: tighten the form so its submit button also lands inside the first viewport."
}
```

Severity is `critical | high | medium | low | informational`, and it is **contextual**: the same
observation scores differently on a sales page and an application funnel. A third-party console error on a
page that rendered fine is `informational`, not a defect. `critical` requires evidence of an actual
functional or conversion failure.

Every issue cites observed values. Rules that cannot cite evidence do not exist, and emptiness that is
normal for a funnel type never produces an issue. **False positives are treated as worse than missed
minor issues.**

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port (Render sets this) |
| `HOST` | `0.0.0.0` | Listen address |
| `MAX_CONCURRENT_ANALYSES` | `2` | Analyses running at once |
| `BROWSER_TIMEOUT_MS` | `30000` | Per-operation Playwright timeout |
| `NAVIGATION_TIMEOUT_MS` | `30000` | Page load timeout |
| `ANALYSIS_TIMEOUT_MS` | `120000` | Hard ceiling for one `/analyze` call |
| `BROWSER_CHANNEL` | *(empty)* | Set to `chrome` to use an installed Chrome instead of bundled Chromium |
| `CHECK_MOBILE_VIEWPORT` | `true` | Second mobile-viewport pass (costs an extra page load) |
| `CHECK_LINKS` / `MAX_LINK_CHECKS` | `true` / `25` | Same-origin link checking |
| `ALLOW_PRIVATE_HOSTS` | `false` | **Local testing only.** Permits localhost/private IPs |

## Security

`/analyze` accepts arbitrary URLs, so it is treated as an SSRF surface:

- only `http:` and `https:`; every other scheme (`file:`, `data:`, `gopher:`, `ws:`, …) is rejected
- credentials in the URL are rejected
- localhost, `.local`, `.internal`, cloud metadata hosts and the `169.254.169.254` metadata IP are blocked
- private and reserved ranges are blocked, including IPv6 unique-local/link-local and IPv4-mapped IPv6
- obfuscated IPv4 forms (decimal, octal, hex) are normalised before the range check
- the **same guard** is applied to every link the link checker touches
- navigation, analysis and queue waits are all bounded; concurrency is capped
- responses never contain stack traces or internal paths; logged URLs are stripped of query strings

Pre-flight validation cannot fully defeat DNS rebinding. If you expose this service publicly, run it in a
network segment with no access to internal services.

## Architecture

```
POST /analyze
   ↓  api/server.ts              routing, validation, concurrency, timeouts
   ↓  api/url_guard.ts           SSRF checks
   ↓  pipeline/capture.ts        one render: navigate, settle, snapshot, link-check
   ↓  extraction/*               DOM snapshot + detectors (forms, CTAs, video, pricing, proof, …)
   ↓  analysis/sections/*        one module per section, pure functions
   ↓  analysis/sections/raw_evidence  the unjudged reading, with its completeness ledger
   ↓  analysis/observed_issues   deterministic, evidence-backed rules
   ↓  JSON response
```

No queues, no Redis, no database, no background workers, no authentication. One process, one browser,
isolated contexts per request.

Nothing is written to disk. The analysis is returned in the HTTP response and the browser context is
closed; a request leaves no artifacts behind.

## Business enrichment

The API deliberately stops at the landing page. `analysis.funnel.business_identity` carries the raw
identity signals (domain, brand name, organisation names, emails, phones, social profiles) that a separate
service can feed into Hunter/RocketReach:

```
Landing analysis → business identification → Hunter / RocketReach → owner name → owner email
```

No enrichment provider is called from this service.

## Tests

```bash
npm test
```

Covers landing-page analysis, VSL detection, CTA detection, form detection without submission, tracking,
SEO, contextual severity, observed issues, raw-evidence capture and its completeness ledger,
`capture_profile`, `/analyze`, `/health`, invalid URLs, SSRF rejection, browser cleanup, and repeated
sequential analyses. Browser-backed tests run against a local fixture server.

## What was removed

This service replaced an interactive funnel crawler. The old manual-takeover, form-filling, Typeform,
Calendly-booking and confirmation-page code was moved out of `src/` to `legacy/interaction-workflow/`
(excluded from the build and the Docker image) rather than deleted, because the project is not under
version control. Delete that folder whenever you are ready.
