import type { Page } from "playwright";
import type { DomSnapshot, FieldPurpose, FoldPosition } from "../types/index.js";
import { inferFieldPurpose } from "./field_purpose.js";

export async function captureDomSnapshot(page: Page): Promise<DomSnapshot> {
  await page.evaluate(
    `globalThis.__name = globalThis.__name || function (target) { return target; };`,
  );
  const raw = await page.evaluate(() => {
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

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

    const jsonLd: unknown[] = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        jsonLd.push(JSON.parse(s.textContent || "null"));
      } catch {
        jsonLd.push({ parse_error: true, raw: (s.textContent || "").slice(0, 500) });
      }
    });

    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map(
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

    const paragraphEls = Array.from(
      document.querySelectorAll("p, li, blockquote, [class*='subtitle'], [class*='subhead']"),
    );
    const paragraphs = paragraphEls.slice(0, 400).map((el) => {
      const rect = el.getBoundingClientRect();
      const visible = isVisible(el);
      return {
        text: textOf(el),
        visible,
        position: foldOf(rect.top, visible),
        y: Math.round(rect.top + window.scrollY),
      };
    }).filter((p) => p.text && p.text.length > 1 && p.text.length < 2000);

    const buttonLike = Array.from(
      document.querySelectorAll(
        "a, button, input[type='submit'], input[type='button'], [role='button']",
      ),
    );
    const buttons = buttonLike.slice(0, 300).map((el) => {
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

    const navRoots = Array.from(document.querySelectorAll("nav, header, [role='navigation']"));
    const footerRoots = Array.from(document.querySelectorAll("footer, [role='contentinfo']"));
    const links = Array.from(document.querySelectorAll("a[href]"))
      .slice(0, 400)
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

    const sections = Array.from(
      document.querySelectorAll("section, main > div, article, header, footer"),
    )
      .slice(0, 60)
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

    const fieldNodes = (form: HTMLFormElement): Element[] =>
      Array.from(
        form.querySelectorAll(
          "input, textarea, select, [contenteditable='true']",
        ),
      );

    const forms = Array.from(document.querySelectorAll("form")).map((formEl) => {
      const form = formEl as HTMLFormElement;
      const rect = form.getBoundingClientRect();
      const visible = isVisible(form);
      const fields = fieldNodes(form)
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
          const options =
            html.tagName === "SELECT"
              ? Array.from((html as HTMLSelectElement).options)
                  .map((o) => o.text.trim())
                  .filter(Boolean)
                  .slice(0, 50)
              : Array.from(form.querySelectorAll(`input[name="${html.getAttribute("name") || ""}"]`))
                  .filter((x) => /radio|checkbox/i.test((x as HTMLInputElement).type))
                  .map((x) => (x as HTMLInputElement).value || labelFor(x as HTMLElement) || "")
                  .filter(Boolean);
          return {
            name: html.getAttribute("name"),
            id: html.id || null,
            label: labelFor(html),
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

      const submit =
        form.querySelector("button[type='submit'], input[type='submit'], button:not([type])") ||
        form.querySelector("[type='submit']");
      const nearbyHeading =
        form.closest("section, article, div")?.querySelector("h1,h2,h3,h4") ||
        form.previousElementSibling;

      const modalHost = form.closest(
        "[role='dialog'], dialog, [class*='modal'], [class*='popup'], [id*='modal'], [id*='popup']",
      );
      return {
        selector: getSelector(form),
        action: form.action || null,
        method: (form.method || "get").toLowerCase(),
        visible,
        in_modal: Boolean(modalHost),
        y: Math.round(rect.top + window.scrollY),
        fields,
        submit_text: submit
          ? (submit as HTMLInputElement).value || textOf(submit)
          : null,
        heading_near: nearbyHeading ? textOf(nearbyHeading as Element) : null,
      };
    });

    const orphanFields = Array.from(
      document.querySelectorAll(
        "input:not(form input), textarea:not(form textarea), select:not(form select)",
      ),
    ).filter((f) => {
      const type = (f.getAttribute("type") || "").toLowerCase();
      return !["hidden", "submit", "button", "image", "reset"].includes(type);
    });

    if (orphanFields.length && forms.length === 0) {
      const first = orphanFields[0] as HTMLElement;
      const container =
        first.closest("[class*='form'], [id*='form'], section, article, div") || first.parentElement;
      forms.push({
        selector: container ? getSelector(container) : null,
        action: null,
        method: "unknown",
        visible: container ? isVisible(container) : true,
        in_modal: false,
        y: Math.round(first.getBoundingClientRect().top + window.scrollY),
        fields: orphanFields.slice(0, 40).map((f) => {
          const html = f as HTMLElement;
          return {
            name: html.getAttribute("name"),
            id: html.id || null,
            label: labelFor(html),
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
        submit_text:
          textOf(
            document.querySelector(
              "button[type='submit'], input[type='submit'], button:not([type])",
            ) as Element,
          ) || null,
        heading_near: null,
      });
    }

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

    document.querySelectorAll("video").forEach((v) => {
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

    const images = Array.from(document.querySelectorAll("img"))
      .slice(0, 200)
      .map((img) => {
        const rect = img.getBoundingClientRect();
        const visible = isVisible(img);
        return {
          src: img.currentSrc || img.src || img.getAttribute("data-src"),
          alt: img.alt || null,
          visible,
          position: foldOf(rect.top, visible),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((i) => i.width >= 20 && i.height >= 20);

    const iframes = Array.from(document.querySelectorAll("iframe")).map((frame) => {
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

    const timers = Array.from(
      document.querySelectorAll(
        "[class*='countdown'], [id*='countdown'], [class*='timer'], [id*='timer'], [class*='clock']",
      ),
    )
      .slice(0, 30)
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

    const dialogs = Array.from(
      document.querySelectorAll("[role='dialog'], dialog, [class*='modal'], [class*='popup']"),
    )
      .slice(0, 20)
      .map((el) => ({
        text: textOf(el).slice(0, 500),
        visible: isVisible(el),
        role: el.getAttribute("role"),
      }));

    const bodyOverflowX = document.documentElement.scrollWidth > window.innerWidth + 8;

    const scripts = Array.from(document.querySelectorAll("script"))
      .slice(0, 300)
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
        return {
          src,
          host,
          inline_snippet: src ? null : (el.textContent || "").replace(/\s+/g, " ").slice(0, 300) || null,
        };
      });

    const trackingGlobals = [
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
    ].filter((name) => {
      try {
        return typeof (window as unknown as Record<string, unknown>)[name] !== "undefined";
      } catch {
        return false;
      }
    });

    const brokenImages = Array.from(document.querySelectorAll("img"))
      .filter((img) => img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src))
      .slice(0, 40)
      .map((img) => ({
        src: img.currentSrc || img.src || null,
        alt: img.alt || null,
        y: Math.round(img.getBoundingClientRect().top + window.scrollY),
      }));

    return {
      url: location.href,
      title: document.title || "",
      scripts,
      tracking_globals: trackingGlobals,
      broken_images: brokenImages,
      lang: document.documentElement.getAttribute("lang"),
      has_viewport_meta: Boolean(document.querySelector('meta[name="viewport"]')),
      meta,
      json_ld: jsonLd,
      viewport: {
        width: viewportW,
        height: viewportH,
        scroll_width: document.documentElement.scrollWidth,
        scroll_height: document.documentElement.scrollHeight,
      },
      visible_text: (document.body?.innerText || "").slice(0, 100000),
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

  return raw as unknown as DomSnapshot;
}
