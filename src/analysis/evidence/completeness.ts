/**
 * Declared incompleteness.
 *
 * Every collector in this service is partial: a cap keeps one hostile page from
 * filling the response, and a filter drops what the collector judged
 * uninteresting. The problem is that a truncated list and an empty page are
 * indistinguishable once the evidence leaves here - "links: []" reads as "the
 * page has no links" whether that is true or whether the cap ate them.
 *
 * So a silent cap is a correctness bug, not a performance detail. The ledger is
 * where each one is admitted: a reader may only conclude "there is no X on this
 * page" over a field the ledger marks complete.
 */

export interface CompletenessEntry {
  /** The snapshot field this describes, e.g. "links" or "meta_all". */
  field: string;
  /** How many entries the snapshot actually carries. */
  captured: number;
  /** How many the page held, counted before the cap and the filters. */
  total: number;
  /** True only when nothing was dropped. Absence claims need this. */
  complete: boolean;
  /** The limit that applied, or null where the collector took everything. */
  cap: number | null;
}

/**
 * The envelope every new collection ships in. The counts travel with the items
 * rather than in a table beside them, so a consumer cannot read the list
 * without also being handed the reason it might be short.
 */
export interface CapturedCollection<T> {
  items: T[];
  total: number;
  truncated: boolean;
  cap: number | null;
}

export class CompletenessLedger {
  /** Keyed by field, so a collector that re-declares itself corrects its row. */
  private readonly rows = new Map<string, CompletenessEntry>();

  record(field: string, captured: number, total: number, cap: number | null): void {
    // A collector that counts its candidates after its own filtering can report
    // more captured than total. Trusting the larger number keeps `complete`
    // from claiming a collection is whole on the strength of a bad count.
    const seen = Math.max(total, captured);
    this.rows.set(field, { field, captured, total: seen, complete: captured === seen, cap });
  }

  entries(): CompletenessEntry[] {
    return [...this.rows.values()];
  }
}
