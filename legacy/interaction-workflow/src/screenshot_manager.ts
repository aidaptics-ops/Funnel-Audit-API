import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { PageType, ScreenshotRecord } from "../types/index.js";

export class ScreenshotManager {
  readonly dir: string;
  private readonly records: ScreenshotRecord[] = [];

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  filename(step: number, pageType: PageType, kind: string): string {
    const safeType = pageType.replace(/[^a-z0-9_]/gi, "_");
    const safeKind = kind.replace(/[^a-z0-9_]/gi, "_");
    return `${String(step).padStart(3, "0")}_${safeType}_${safeKind}.png`;
  }

  async capture(
    page: Page,
    opts: { step: number; pageType: PageType; kind: string; fullPage?: boolean },
  ): Promise<ScreenshotRecord | null> {
    const filename = this.filename(opts.step, opts.pageType, opts.kind);
    const path = join(this.dir, filename);
    try {
      await page.screenshot({
        path,
        fullPage: Boolean(opts.fullPage),
        timeout: 15000,
      });
      const record: ScreenshotRecord = {
        path,
        filename,
        kind: opts.kind,
        page_step: opts.step,
        url: page.url(),
        page_type: opts.pageType,
      };
      this.records.push(record);
      return record;
    } catch (error) {
      return null;
    }
  }

  all(): ScreenshotRecord[] {
    return [...this.records];
  }
}
