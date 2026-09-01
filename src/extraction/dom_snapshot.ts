import type { Page } from "playwright";
import { CompletenessLedger } from "../analysis/evidence/completeness.js";
import type { DomSnapshot, FieldPurpose, FoldPosition } from "../types/index.js";
import { inferFieldPurpose } from "./field_purpose.js";

export async function captureDomSnapshot(page: Page): Promise<DomSnapshot> {
  await page.evaluate(
    `globalThis.__name = globalThis.__name || function (target) { return target; };`,
  );
  const raw = await page.evaluate(() => {
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    /**
     * Caps exist so one hostile page cannot fill the response. Not one of them
     * is applied silently: each collector declares what it kept against what
     * the page held, because downstream a truncated list is indistinguishable
     * from a page that has none of the thing.
     */
    const CAP = {
      paragraphs: 1000,
      buttons: 800,
      links: 1200,
      scripts: 600,
      inline_snippet: 2000,
      images: 600,
      /** The judged `images` list keeps the collector's original ceiling. */
      images_judged: 200,
      /** Choices kept per <select>. Declared, like every other cap here. */
      options: 50,
      sections: 60,
      timers: 30,
      dialogs: 20,
      meta: 300,
      links_rel: 200,
      hidden_inputs: 400,
      embeds: 400,
      broken_images: 40,
      visible_text: 100000,
    };

    // Plain rows rather than the ledger itself: this side of page.evaluate is
    // the browser, and only structured-cloneable data crosses back.
    const declared: Array<{ field: string; captured: number; total: number; cap: number | null }> = [];
    const declare = (field: string, captured: number, total: number, cap: number | null): void => {
      declared.push({ field, captured, total, cap });
    };

    const foldOf = (y: number, visible: boolean): FoldPosition => {
      if (!visible) return "unknown";
      return y < viewportH ? "above_fold" : "below_fold";
    };

    const isVisible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      if (style.position === "fixed" || style.position === "sticky") return true;
      return true;
    };

    const cssEscape = (value: string): string => {
      if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
      return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    };

    const getSelector = (el: Element | null): string | null => {
      if (!el || !(el instanceof Element)) return null;
      if (el.id) return `#${cssEscape(el.id)}`;
      const name = el.getAttribute("name");
      if (name) return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
      const data = el.getAttribute("data-testid") || el.getAttribute("data-qa");
      if (data) return `[data-testid="${cssEscape(data)}"]`;
      const parts: string[] = [];
      let node: Element | null = el;
      let depth = 0;
      while (node && depth < 5) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          parts.unshift(`#${cssEscape(node.id)}`);
          break;
        }
        const parent: HTMLElement | null = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (c) => c.tagName === node!.tagName,
          );
          if (siblings.length > 1) {
            part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
          }
        }
        parts.unshift(part);
        node = parent;
        depth += 1;
      }
      return parts.join(" > ");
    };

    const textOf = (el: Element | null): string =>
      (el?.textContent || "").replace(/\s+/g, " ").trim();

    const labelFor = (field: HTMLElement): string | null => {
      const id = field.getAttribute("id");
      if (id) {
        const label = document.querySelector(`label[for="${cssEscape(id)}"]`);
        if (label) return textOf(label);
      }
      const wrapped = field.closest("label");
      if (wrapped) return textOf(wrapped);
      const aria = field.getAttribute("aria-label");
      if (aria) return aria;
      const labelledBy = field.getAttribute("aria-labelledby");
      if (labelledBy) {
        return labelledBy
          .split(/\s+/)
          .map((lid) => textOf(document.getElementById(lid)))
          .filter(Boolean)
          .join(" ");
      }
      const prev = field.previousElementSibling;
      if (prev && /label|span|p|div|legend/i.test(prev.tagName)) {
        const t = textOf(prev);
        if (t && t.length < 120) return t;
      }
      return field.getAttribute("placeholder");
    };

    const metaContent = (selector: string): string | null =>
      document.querySelector(selector)?.getAttribute("content") || null;

    const meta = {
      description: metaContent('meta[name="description"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") || null,
      og_title: metaContent('meta[property="og:title"]'),
      og_description: metaContent('meta[property="og:description"]'),
      og_image: metaContent('meta[property="og:image"]'),
      og_type: metaContent('meta[property="og:type"]'),
      og_site_name: metaContent('meta[property="og:site_name"]'),
      og_url: metaContent('meta[property="og:url"]'),
      twitter_card: metaContent('meta[name="twitter:card"]') || metaContent('meta[property="twitter:card"]'),
      twitter_title: metaContent('meta[name="twitter:title"]') || metaContent('meta[property="twitter:title"]'),
      twitter_description:
        metaContent('meta[name="twitter:description"]') || metaContent('meta[property="twitter:description"]'),
      twitter_image: metaContent('meta[name="twitter:image"]') || metaContent('meta[property="twitter:image"]'),
      robots: metaContent('meta[name="robots"]'),
      author: metaContent('meta[name="author"]'),
      generator: metaContent('meta[name="generator"]'),
      theme_color: metaContent('meta[name="theme-color"]'),
    };

    // The whitelist above is what the analysis reads. This is everything the
    // page declared, so a reader can recognise a vendor tag nobody here named.
    const metaEls = Array.from(document.querySelectorAll("meta"));
    const metaAllItems = metaEls.slice(0, CAP.meta).map((el) => ({
      name: el.getAttribute("name"),
      property: el.getAttribute("property"),
      http_equiv: el.getAttribute("http-equiv"),
      content: el.getAttribute("content"),
    }));
    declare("meta_all", metaAllItems.length, metaEls.length, CAP.meta);

    const charset =
      document.characterSet || document.querySelector("meta[charset]")?.getAttribute("charset") || null;

    const linkRelEls = Array.from(document.querySelectorAll("link[rel]"));
    const linksRelItems = linkRelEls.slice(0, CAP.links_rel).map((el) => ({
      rel: el.getAttribute("rel"),
      href: el.getAttribute("href"),
      type: el.getAttribute("type"),
    }));
    declare("links_rel", linksRelItems.length, linkRelEls.length, CAP.links_rel);

    const jsonLd: unknown[] = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        jsonLd.push(JSON.parse(s.textContent || "null"));
      } catch {
        jsonLd.push({ parse_error: true, raw: (s.textContent || "").slice(0, 500) });
      }
    });
    declare("json_ld", jsonLd.length, jsonLd.length, null);

    const headingEls = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"));
    const headings = headingEls.map(
      (el) => {
        const rect = el.getBoundingClientRect();
        const y = Math.round(rect.top + window.scrollY);
        const visible = isVisible(el);
        return {
          level: Number(el.tagName.slice(1)),
          text: textOf(el),
          visible,
          position: foldOf(rect.top, visible),
          y,
        };
      },
    ).filter((h) => h.text);
    declare("headings", headings.length, headingEls.length, null);

    const paragraphEls = Array.from(
      document.querySelectorAll("p, li, blockquote, [class*='subtitle'], [class*='subhead']"),
    );
    const paragraphs = paragraphEls.slice(0, CAP.paragraphs).map((el) => {
      const rect = el.getBoundingClientRect();
      const visible = isVisible(el);
      return {
        text: textOf(el),
        visible,
        position: foldOf(rect.top, visible),
        y: Math.round(rect.top + window.scrollY),
      };
    }).filter((p) => p.text && p.text.length > 1 && p.text.length < 2000);
    declare("paragraphs", paragraphs.length, paragraphEls.length, CAP.paragraphs);

    const buttonLike = Array.from(
      document.querySelectorAll(
        "a, button, input[type='submit'], input[type='button'], [role='button']",
      ),
    );
    const buttons = buttonLike.slice(0, CAP.buttons).map((el) => {
      const rect = el.getBoundingClientRect();
      const visible = isVisible(el);
      const href = el instanceof HTMLAnchorElement ? el.href : el.getAttribute("href");
      const value =
        el instanceof HTMLInputElement ? el.value : textOf(el) || el.getAttribute("aria-label");
      return {
        text: (value || "").replace(/\s+/g, " ").trim(),
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type"),
        href: href || null,
        visible,
        position: foldOf(rect.top, visible),
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        selector: getSelector(el),
      };
    }).filter((b) => b.text || b.href);
    declare("buttons", buttons.length, buttonLike.length, CAP.buttons);

    const navRoots = Array.from(document.querySelectorAll("nav, header, [role='navigation']"));
    const footerRoots = Array.from(document.querySelectorAll("footer, [role='contentinfo']"));
    const anchorEls = Array.from(document.querySelectorAll("a[href]"));
    const links = anchorEls
      .slice(0, CAP.links)
      .map((el) => {
        const a = el as HTMLAnchorElement;
        const rect = a.getBoundingClientRect();
        const visible = isVisible(a);
        return {
          text: textOf(a),
          href: a.href || null,
          visible,
          position: foldOf(rect.top, visible),
          in_nav: navRoots.some((root) => root.contains(a)),
          in_footer: footerRoots.some((root) => root.contains(a)),
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
        };
      });
    declare("links", links.length, anchorEls.length, CAP.links);

    const sectionEls = Array.from(
      document.querySelectorAll("section, main > div, article, header, footer"),
    );
    const sections = sectionEls
      .slice(0, CAP.sections)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          heading: textOf(el.querySelector("h1,h2,h3")).slice(0, 160) || null,
          y: Math.round(rect.top + window.scrollY),
          height: Math.round(rect.height),
        };
      })
      .filter((s) => s.height > 40);
    declare("sections", sections.length, sectionEls.length, CAP.sections);

    const fieldNodes = (form: HTMLFormElement): Element[] =>
      Array.from(
        form.querySelectorAll(
          "input, textarea, select, [contenteditable='true']",
        ),
      );

    /** Every foreign document nested inside a container, src untouched. */
    const embeddedDocumentsIn = (root: Element): Array<{ tag: string; src: string | null; title: string | null }> =>
      Array.from(root.querySelectorAll("iframe, embed, object")).map((el) => ({
        tag: el.tagName.toLowerCase(),
        src: el.getAttribute("src") || el.getAttribute("data-src") || el.getAttribute("data") || null,
        title: el.getAttribute("title"),
      }));

    const formEls = Array.from(document.querySelectorAll("form"));
    // Counted so the ledger can say how many field nodes the collector's type
    // filter dropped; the hidden ones are reported separately below.
    let fieldNodesSeen = 0;
    let fieldsKept = 0;
    // A cap inside a field is as silent as a cap on the field list: a country
    // list cut at 50 reads as a checkout that does not ship to Vietnam.
    let optionsSeen = 0;
    let optionsKept = 0;
    let embeddedInFormsSeen = 0;
    const forms = formEls.map((formEl) => {
      const form = formEl as HTMLFormElement;
      const rect = form.getBoundingClientRect();
      const visible = isVisible(form);
      const nodes = fieldNodes(form);
      fieldNodesSeen += nodes.length;
      const fields = nodes
        .filter((f) => {
          const type = (f.getAttribute("type") || "").toLowerCase();
          return !["hidden", "submit", "button", "image", "reset"].includes(type);
        })
        .map((f) => {
          const html = f as HTMLElement;
          const type =
            html.getAttribute("type") ||
            (html.tagName === "SELECT"
              ? "select"
              : html.tagName === "TEXTAREA"
                ? "textarea"
                : "text");
          const isSelect = html.tagName === "SELECT";
          const allOptions = isSelect
            ? Array.from((html as HTMLSelectElement).options)
                .map((o) => o.text.trim())
                .filter(Boolean)
            : Array.from(form.querySelectorAll(`input[name="${html.getAttribute("name") || ""}"]`))
                .filter((x) => /radio|checkbox/i.test((x as HTMLInputElement).type))
                .map((x) => (x as HTMLInputElement).value || labelFor(x as HTMLElement) || "")
                .filter(Boolean);
          // Only a <select> is capped, as it always was; a radio group is kept
          // whole. Both are counted, so the ledger describes every choice the
          // page offered against every choice reported.
          const options = isSelect ? allOptions.slice(0, CAP.options) : allOptions;
          optionsSeen += allOptions.length;
          optionsKept += options.length;
          return {
            name: html.getAttribute("name"),
            id: html.id || null,
            label: labelFor(html),
            // The element itself, which `type` cannot express: a
            // contenteditable div and a text input both report "text".
            tag: html.tagName.toLowerCase(),
            type,
            placeholder: html.getAttribute("placeholder"),
            required: html.hasAttribute("required") || html.getAttribute("aria-required") === "true",
            autocomplete: html.getAttribute("autocomplete"),
            options,
            purpose: "other" as FieldPurpose,
            checked:
              html instanceof HTMLInputElement && (html.type === "checkbox" || html.type === "radio")
                ? html.checked
                : null,
            value_present: Boolean(
              (html instanceof HTMLInputElement ||
                html instanceof HTMLTextAreaElement ||
                html instanceof HTMLSelectElement) &&
                html.value,
            ),
            selector: getSelector(html),
          };
        });
      fieldsKept += fields.length;

      const submit =
        form.querySelector("button[type='submit'], input[type='submit'], button:not([type])") ||
        form.querySelector("[type='submit']");
      const nearbyHeading =
        form.closest("section, article, div")?.querySelector("h1,h2,h3,h4") ||
        form.previousElementSibling;

      const modalHost = form.closest(
        "[role='dialog'], dialog, [class*='modal'], [class*='popup'], [id*='modal'], [id*='popup']",
      );
      // A <form> whose actual field is a third party's embedded document. The
      // src is reported as it stands; naming the vendor is somebody else's job.
      const embeddedIframes = embeddedDocumentsIn(form);
      embeddedInFormsSeen += embeddedIframes.length;
      return {
        selector: getSelector(form),
        name: form.getAttribute("name"),
        id: form.id || null,
        action: form.action || null,
        method: (form.method || "get").toLowerCase(),
        visible,
        in_modal: Boolean(modalHost),
        y: Math.round(rect.top + window.scrollY),
        fields,
        embedded_iframes: embeddedIframes,
        submit_text: submit
          ? (submit as HTMLInputElement).value || textOf(submit)
          : null,
        heading_near: nearbyHeading ? textOf(nearbyHeading as Element) : null,
      };
    });

    const orphanCandidates = Array.from(
      document.querySelectorAll(
        "input:not(form input), textarea:not(form textarea), select:not(form select)",
      ),
    );
    fieldNodesSeen += orphanCandidates.length;
    const orphanFields = orphanCandidates.filter((f) => {
      const type = (f.getAttribute("type") || "").toLowerCase();
      return !["hidden", "submit", "button", "image", "reset"].includes(type);
    });

    // An orphan field is only ever collected when the page declared no form at
    // all; everywhere else these nodes are dropped, which the ledger records.
    if (orphanFields.length && forms.length === 0) {
      fieldsKept += Math.min(orphanFields.length, 40);
      const first = orphanFields[0] as HTMLElement;
      const container =
        first.closest("[class*='form'], [id*='form'], section, article, div") || first.parentElement;
      forms.push({
        selector: container ? getSelector(container) : null,
        // A synthesised form: the page declared none, so there is no <form>
        // whose name or id could be reported here.
        name: null,
        id: container?.id || null,
        action: null,
        method: "unknown",
        visible: container ? isVisible(container) : true,
        in_modal: false,
        y: Math.round(first.getBoundingClientRect().top + window.scrollY),
        fields: orphanFields.slice(0, 40).map((f) => {
          const html = f as HTMLElement;
          // A synthesised form does not read a <select>'s choices, which the
          // empty list below would otherwise report as a select with none.
          if (html.tagName === "SELECT") optionsSeen += (html as HTMLSelectElement).options.length;
          return {
            name: html.getAttribute("name"),
            id: html.id || null,
            label: labelFor(html),
            tag: html.tagName.toLowerCase(),
            type:
              html.getAttribute("type") ||
              (html.tagName === "SELECT" ? "select" : html.tagName === "TEXTAREA" ? "textarea" : "text"),
            placeholder: html.getAttribute("placeholder"),
            required: html.hasAttribute("required"),
            autocomplete: html.getAttribute("autocomplete"),
            options: [],
            purpose: "other" as FieldPurpose,
            checked: null,
            value_present: false,
            selector: getSelector(html),
          };
        }),
        embedded_iframes: container ? embeddedDocumentsIn(container) : [],
        submit_text:
          textOf(
            document.querySelector(
              "button[type='submit'], input[type='submit'], button:not([type])",
            ) as Element,
          ) || null,
        heading_near: null,
      });
      embeddedInFormsSeen += forms[0]?.embedded_iframes.length ?? 0;
    }
    declare("forms", forms.length, Math.max(formEls.length, forms.length), null);
    declare("forms.fields", fieldsKept, fieldNodesSeen, null);
    // How many choices survived, across every field that offers any. The
    // `forms.fields` row counts field nodes, which says nothing about the
    // options inside one of them.
    declare("forms.fields.options", optionsKept, optionsSeen, CAP.options);
    // Unfiltered: every iframe, embed and object nested in a form is kept, so
    // this row can honestly read complete.
    declare("forms.embedded_iframes", embeddedInFormsSeen, embeddedInFormsSeen, null);

    /**
     * Hidden inputs, which both field collectors above drop: a form's declared
     * state is evidence of what it posts and who processes it. Collected across
     * the document rather than per form so an input outside any form is kept
     * too, with the owning form named instead of the record duplicated.
     *
     * The value is deliberately never read - a hidden input routinely carries a
     * CSRF token, a session id or a prefilled email.
     */
    const hiddenInputEls = Array.from(document.querySelectorAll("input[type='hidden' i]"));
    const hiddenInputItems = hiddenInputEls.slice(0, CAP.hidden_inputs).map((el) => {
      const input = el as HTMLInputElement;
      const owner = input.closest("form");
      return {
        type: "hidden" as const,
        name: input.getAttribute("name"),
        id: input.id || null,
        value_present: Boolean(input.value),
        form_selector: owner ? getSelector(owner) : null,
      };
    });
    declare("hidden_inputs", hiddenInputItems.length, hiddenInputEls.length, CAP.hidden_inputs);

    const videoProvider = (src: string): string => {
      const s = src.toLowerCase();
      if (s.includes("youtube") || s.includes("youtu.be") || s.includes("ytimg")) return "youtube";
      if (s.includes("vimeo")) return "vimeo";
      if (s.includes("wistia") || s.includes("wi.st")) return "wistia";
      if (s.includes("loom.com")) return "loom";
      if (s.includes("vidalytics")) return "vidalytics";
      if (s.includes("bunnycdn") || s.includes("mediadelivery")) return "bunny";
      if (s.includes("jwplatform") || s.includes("jwpcdn")) return "jwplayer";
      if (s.includes("brightcove")) return "brightcove";
      if (s.includes("vimeocdn")) return "vimeo";
      return "unknown";
    };

    const videos: Array<Record<string, unknown>> = [];
    // Video detection is a set of heuristics, not a query: an embed it cannot
    // recognise is silently not a video. Counting what was looked at keeps the
    // ledger from ever certifying "this page has no video".
    let videoCandidates = 0;

    document.querySelectorAll("video").forEach((v) => {
      videoCandidates += 1;
      const rect = v.getBoundingClientRect();
      const visible = isVisible(v);
      videos.push({
        provider: "html5",
        embedded: true,
        visible,
        autoplay: v.hasAttribute("autoplay") || v.autoplay,
        muted: v.hasAttribute("muted") || v.muted,
        controls: v.hasAttribute("controls") || v.controls,
        duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null,
        src: v.currentSrc || v.src || v.querySelector("source")?.getAttribute("src") || null,
        position: foldOf(rect.top, visible),
        play_button_visible: false,
        thumbnail: v.poster || null,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        y: Math.round(rect.top + window.scrollY),
        analysis_limitation: v.duration ? null : "HTML5 video duration was not available",
      });
    });

    const iframeSelectors = "iframe, embed, object";
    document.querySelectorAll(iframeSelectors).forEach((frame) => {
      videoCandidates += 1;
      const src =
        frame.getAttribute("src") ||
        frame.getAttribute("data-src") ||
        frame.getAttribute("data-video-src") ||
        "";
      const provider = videoProvider(src);
      const isFormEmbed =
        /typeform\.com|jotform\.com|tally\.so|fillout\.com|paperform|forms\.gle|google\.com\/forms|calendly\.com|cal\.com|acuityscheduling|tidycal|hubspot\.com\/meetings/i.test(
          src,
        );
      if (isFormEmbed) return;
      const looksVideo =
        provider !== "unknown" ||
        /youtube|youtu\.be|vimeo|wistia|loom|vidalytics|jwplayer|brightcove|\/video|player\./i.test(src) ||
        /wistia|youtube|vimeo/i.test(frame.className + (frame.id || ""));
      if (!looksVideo) return;
      const rect = frame.getBoundingClientRect();
      const visible = isVisible(frame);
      videos.push({
        provider,
        embedded: true,
        visible,
        autoplay: /autoplay=1|autoplay=true/i.test(src) ? true : /autoplay=0/i.test(src) ? false : null,
        muted: /mute=1|muted=1|muted=true/i.test(src) ? true : null,
        controls: /controls=0/i.test(src) ? false : null,
        duration: null,
        src: src || null,
        position: foldOf(rect.top, visible),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        y: Math.round(rect.top + window.scrollY),
        play_button_visible: false,
        thumbnail: null,
        analysis_limitation:
          "Cross-origin iframe contents cannot be inspected; duration and transcript are unavailable",
      });
    });

    document.querySelectorAll("[class*='wistia'], [id*='wistia'], [class*='video'], [data-video-id]").forEach(
      (el) => {
        if (el.tagName === "IFRAME" || el.tagName === "VIDEO") return;
        videoCandidates += 1;
        const rect = el.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 80) return;
        const visible = isVisible(el);
        const src = el.getAttribute("data-src") || el.getAttribute("data-video-id") || "";
        videos.push({
          provider: videoProvider(src + " " + el.className),
          embedded: true,
          visible,
          autoplay: null,
          duration: null,
          src: src || null,
          position: foldOf(rect.top, visible),
          play_button_visible: Boolean(
            el.querySelector("[class*='play'], button, [aria-label*='play' i]"),
          ),
          thumbnail: el.querySelector("img")?.getAttribute("src") || null,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          y: Math.round(rect.top + window.scrollY),
          analysis_limitation: "Custom video player internals were not inspected",
        });
        if (!videos[videos.length - 1].src && !videos[videos.length - 1].play_button_visible) {
          videos.pop();
        }
      },
    );

    const playButtons = Array.from(
      document.querySelectorAll(
        "[aria-label*='play' i], [class*='play-button'], [class*='playButton']",
      ),
    );
    if (videos.length === 0 && playButtons.length) {
      videoCandidates += playButtons.length;
      const el = playButtons[0] as HTMLElement;
      const rect = el.getBoundingClientRect();
      const visible = isVisible(el);
      videos.push({
        provider: "unknown",
        embedded: false,
        visible,
        autoplay: false,
        duration: null,
        src: null,
        position: foldOf(rect.top, visible),
        play_button_visible: true,
        thumbnail: null,
        analysis_limitation: "A play control was visible but the video provider could not be identified",
      });
    }

    const imageEls = Array.from(document.querySelectorAll("img"));
    const imagesAll = imageEls.slice(0, CAP.images).map((img) => {
      const rect = img.getBoundingClientRect();
      const visible = isVisible(img);
      return {
        src: img.currentSrc || img.src || img.getAttribute("data-src"),
        alt: img.alt || null,
        visible,
        position: foldOf(rect.top, visible),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        title: img.getAttribute("title"),
        srcset: img.getAttribute("srcset"),
        sizes: img.getAttribute("sizes"),
        loading: img.getAttribute("loading"),
        id: img.id || null,
        class_name: typeof img.className === "string" ? img.className : null,
        natural_width: img.naturalWidth,
        natural_height: img.naturalHeight,
        // This used to delete everything under 20px. A deleted image reads as
        // an image the page does not have, so the threshold is a flag now and
        // the tracking pixels and spacer gifs come back with it.
        meets_size_threshold: rect.width >= 20 && rect.height >= 20,
      };
    });
    declare("images_all", imagesAll.length, imageEls.length, CAP.images);

    /**
     * The judged list, unchanged: the first 200 <img> elements, minus anything
     * whose rendered box is under 20px square. Every section that counts
     * images, hunts for a logo or reports a missing alt reads this one, and a
     * tracking pixel is not an image a visitor can see - it would arrive as a
     * missing alt or a broken image and be judged as a fault.
     *
     * `images_all` above is the same collection with nothing removed, for the
     * reader whose question this filter was never built to answer. Both are
     * declared, so neither can be mistaken for the whole of what the page held.
     */
    const images = imagesAll
      .slice(0, CAP.images_judged)
      .filter((i) => i.meets_size_threshold);
    declare("images", images.length, imageEls.length, CAP.images_judged);

    const iframeEls = Array.from(document.querySelectorAll("iframe"));
    const iframes = iframeEls.map((frame) => {
      const src = frame.getAttribute("src") || frame.getAttribute("data-src");
      const rect = frame.getBoundingClientRect();
      const visible = isVisible(frame);
      const sameOrigin = (() => {
        try {
          return Boolean(src && new URL(src, location.href).origin === location.origin);
        } catch {
          return false;
        }
      })();
      return {
        src,
        title: frame.getAttribute("title"),
        visible,
        position: foldOf(rect.top, visible),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        inspectable: sameOrigin,
        limitation: sameOrigin
          ? null
          : "Cross-origin iframe; Playwright frame APIs are used when the embed is interactable",
      };
    });
    declare("iframes", iframes.length, iframeEls.length, null);

    /**
     * The wider net over embedded documents. `iframes` above answers the
     * questions the analysis already asks; this one keeps every iframe, embed
     * and object with the attributes that identify the third party - the src,
     * the allow list, the id - so a reader can conclude what the service is
     * without this code ever naming it.
     */
    const embedEls = Array.from(document.querySelectorAll("iframe, embed, object"));
    const embedItems = embedEls.slice(0, CAP.embeds).map((el) => {
      const src =
        el.getAttribute("src") || el.getAttribute("data-src") || el.getAttribute("data") || null;
      const rect = el.getBoundingClientRect();
      const visible = isVisible(el);
      let sameOrigin = false;
      try {
        sameOrigin = Boolean(src && new URL(src, location.href).origin === location.origin);
      } catch {
        sameOrigin = false;
      }
      return {
        tag: el.tagName.toLowerCase(),
        src,
        title: el.getAttribute("title"),
        name: el.getAttribute("name"),
        id: el.id || null,
        class_name: typeof el.className === "string" ? el.className : null,
        allow: el.getAttribute("allow"),
        sandbox: el.getAttribute("sandbox"),
        loading: el.getAttribute("loading"),
        visible,
        position: foldOf(rect.top, visible),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        y: Math.round(rect.top + window.scrollY),
        inspectable: sameOrigin,
      };
    });
    declare("embeds", embedItems.length, embedEls.length, CAP.embeds);

    const timerEls = Array.from(
      document.querySelectorAll(
        "[class*='countdown'], [id*='countdown'], [class*='timer'], [id*='timer'], [class*='clock']",
      ),
    );
    const timers = timerEls
      .slice(0, CAP.timers)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el).slice(0, 200),
          selector: getSelector(el),
          y: Math.round(rect.top + window.scrollY),
          visible: isVisible(el),
        };
      })
      .filter((t) => t.text);
    declare("timers", timers.length, timerEls.length, CAP.timers);

    const dialogEls = Array.from(
      document.querySelectorAll("[role='dialog'], dialog, [class*='modal'], [class*='popup']"),
    );
    const dialogs = dialogEls
      .slice(0, CAP.dialogs)
      .map((el) => ({
        text: textOf(el).slice(0, 500),
        visible: isVisible(el),
        role: el.getAttribute("role"),
      }));
    declare("dialogs", dialogs.length, dialogEls.length, CAP.dialogs);

    const bodyOverflowX = document.documentElement.scrollWidth > window.innerWidth + 8;

    const scriptEls = Array.from(document.querySelectorAll("script"));
    let inlineScripts = 0;
    let inlineScriptsWhole = 0;
    const scripts = scriptEls
      .slice(0, CAP.scripts)
      .map((el) => {
        const src = el.getAttribute("src");
        let host: string | null = null;
        if (src) {
          try {
            host = new URL(src, location.href).hostname;
          } catch {
            host = null;
          }
        }
        let snippet: string | null = null;
        if (!src) {
          const body = (el.textContent || "").replace(/\s+/g, " ");
          inlineScripts += 1;
          if (body.length <= CAP.inline_snippet) inlineScriptsWhole += 1;
          // Long enough now to carry a vendor's init call and its arguments,
          // which is where an embedded service names itself.
          snippet = body.slice(0, CAP.inline_snippet) || null;
        }
        return { src, host, inline_snippet: snippet };
      });
    declare("scripts", scripts.length, scriptEls.length, CAP.scripts);
    declare("scripts.inline_snippet", inlineScriptsWhole, inlineScripts, CAP.inline_snippet);

    const trackingNames = [
      "fbq",
      "gtag",
      "dataLayer",
      "ga",
      "_gaq",
      "ttq",
      "twq",
      "snaptr",
      "pintrk",
      "lintrk",
      "rdt",
      "hj",
      "clarity",
      "analytics",
      "Intercom",
      "drift",
      "$crisp",
      "tidioChatApi",
      "posthog",
      "mixpanel",
      "amplitude",
      "_learnq",
      "wistiaTracker",
    ];

    const globalPresent = (name: string): boolean => {
      try {
        return typeof (window as unknown as Record<string, unknown>)[name] !== "undefined";
      } catch {
        return false;
      }
    };

    const trackingGlobals = trackingNames.filter(globalPresent);

    /**
     * `typeof window[name]` is not only a script probe. HTML named-element
     * access puts every element with an `id`, and every img/form/iframe/embed
     * with a `name`, on window as an own property - so `<div id="Cal">` makes
     * `typeof window.Cal` report "object" on a page that loads no vendor at
     * all. The wide probe below carries short, collision-prone names, and a
     * false name there is not a wart: it is fabricated evidence of a service
     * the page never loaded, in the one section that only observes.
     *
     * So the value is read once and anything the DOM could have put there is
     * rejected. A vendor global is a function or a plain object; an element, a
     * collection of elements and a frame's window are all named-element access.
     */
    const vendorGlobalPresent = (name: string): boolean => {
      try {
        const value = (window as unknown as Record<string, unknown>)[name];
        if (typeof value === "undefined" || value === null) return false;
        if (typeof value !== "object") return true;
        if (typeof Element !== "undefined" && value instanceof Element) return false;
        if (typeof HTMLCollection !== "undefined" && value instanceof HTMLCollection) return false;
        if (typeof Window !== "undefined" && value instanceof Window) return false;
        // A same-origin frame's window fails `instanceof Window` when it is
        // read across realms; its `self === itself` identity does not.
        const maybeWindow = value as { window?: unknown; self?: unknown };
        if (maybeWindow.window === value || maybeWindow.self === value) return false;
        if (typeof Node !== "undefined" && value instanceof Node) return false;
        return true;
      } catch {
        return false;
      }
    };

    /**
     * A vendor global is the strongest single piece of evidence that a
     * third-party service is embedded here: window.Calendly is what makes a
     * page a booking page, and this reports the name without saying so. The
     * tracking probe above stays exactly as it was - the analysis reads it.
     */
    const probedGlobals = Array.from(
      new Set([
        ...trackingNames,
        "Calendly", "Cal", "SavvyCal", "Chilipiper", "hbspt", "HubSpotConversations",
        "Typeform", "tf", "JotForm", "Tally", "Paperform", "gform",
        "Wistia", "_wq", "Vimeo", "YT", "vidalytics", "jwplayer", "videojs",
        "jQuery", "$", "React", "ReactDOM", "Vue", "angular", "Alpine", "Turbo", "htmx",
        "Shopify", "Stripe", "paypal", "Rewardful", "ThriveCart", "Kajabi",
        "Klaviyo", "Mailchimp", "_kmq", "Beacon", "zE", "Tawk_API", "LiveChatWidget",
        "olark", "Podium", "Chatra", "HubSpot", "Marketo", "MktoForms2",
        "elementorFrontend", "wp", "webflow", "Squarespace", "Wix", "unbounce",
        "google_tag_manager", "Sentry", "newrelic", "Optimizely", "VWO", "_vwo_code",
      ]),
    );
    const windowGlobalsPresent = probedGlobals.filter(vendorGlobalPresent);
    // Counted against every global the page actually defines, so the ledger can
    // never license "this page loads no third-party service" off a name probe.
    let ownGlobalCount = windowGlobalsPresent.length;
    try {
      ownGlobalCount = Object.keys(window).length;
    } catch {
      ownGlobalCount = windowGlobalsPresent.length;
    }
    declare("window_globals_present", windowGlobalsPresent.length, ownGlobalCount, null);

    const brokenImageEls = imageEls.filter(
      (img) => img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src),
    );
    const brokenImages = brokenImageEls
      .slice(0, CAP.broken_images)
      .map((img) => ({
        src: img.currentSrc || img.src || null,
        alt: img.alt || null,
        y: Math.round(img.getBoundingClientRect().top + window.scrollY),
      }));
    declare("broken_images", brokenImages.length, brokenImageEls.length, CAP.broken_images);

    declare("videos", videos.length, videoCandidates, null);

    const fullText = document.body?.innerText || "";
    const visibleText = fullText.slice(0, CAP.visible_text);
    declare("visible_text", visibleText.length, fullText.length, CAP.visible_text);

    return {
      url: location.href,
      title: document.title || "",
      scripts,
      tracking_globals: trackingGlobals,
      window_globals_present: windowGlobalsPresent,
      broken_images: brokenImages,
      lang: document.documentElement.getAttribute("lang"),
      has_viewport_meta: Boolean(document.querySelector('meta[name="viewport"]')),
      meta,
      meta_all: {
        items: metaAllItems,
        total: metaEls.length,
        truncated: metaEls.length > metaAllItems.length,
        cap: CAP.meta,
      },
      charset,
      links_rel: {
        items: linksRelItems,
        total: linkRelEls.length,
        truncated: linkRelEls.length > linksRelItems.length,
        cap: CAP.links_rel,
      },
      hidden_inputs: {
        items: hiddenInputItems,
        total: hiddenInputEls.length,
        truncated: hiddenInputEls.length > hiddenInputItems.length,
        cap: CAP.hidden_inputs,
      },
      images_all: {
        items: imagesAll,
        total: imageEls.length,
        truncated: imageEls.length > imagesAll.length,
        cap: CAP.images,
      },
      embeds: {
        items: embedItems,
        total: embedEls.length,
        truncated: embedEls.length > embedItems.length,
        cap: CAP.embeds,
      },
      json_ld: jsonLd,
      viewport: {
        width: viewportW,
        height: viewportH,
        scroll_width: document.documentElement.scrollWidth,
        scroll_height: document.documentElement.scrollHeight,
      },
      visible_text: visibleText,
      headings,
      paragraphs,
      buttons,
      links,
      sections,
      forms,
      videos,
      images,
      iframes,
      timers,
      dialogs,
      body_overflow_x: bodyOverflowX,
      declared,
    };
  });

  for (const form of raw.forms) {
    for (const field of form.fields) {
      field.purpose = inferFieldPurpose({
        name: field.name,
        id: field.id,
        type: field.type,
        label: field.label,
        placeholder: field.placeholder,
        autocomplete: field.autocomplete,
      });
    }
  }

  // The rows crossed the page.evaluate boundary as plain data; the ledger is
  // assembled here so `complete` is decided in one place.
  const { declared, ...snapshot } = raw;
  const ledger = new CompletenessLedger();
  for (const row of declared) {
    ledger.record(row.field, row.captured, row.total, row.cap);
  }

  return { ...snapshot, completeness: ledger.entries() } as unknown as DomSnapshot;
}
