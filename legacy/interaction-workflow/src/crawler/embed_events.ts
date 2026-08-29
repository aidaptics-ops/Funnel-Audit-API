export interface EmbedEvent {
  name: string;
  payload: unknown;
  origin: string | null;
  frame_url: string | null;
  at: string;
}

/**
 * Collects `postMessage` events published by embedded widgets (Calendly emits
 * `calendly.event_scheduled` when a booking completes). This is an event, not a
 * poll, so a booking is noticed the moment the widget reports it.
 */
export class EmbedEventBus {
  private readonly items: EmbedEvent[] = [];

  record(event: Omit<EmbedEvent, "at">): void {
    this.items.push({ ...event, at: new Date().toISOString() });
  }

  get length(): number {
    return this.items.length;
  }

  all(): EmbedEvent[] {
    return [...this.items];
  }

  since(index: number): EmbedEvent[] {
    return this.items.slice(Math.max(0, index));
  }

  findSince(index: number, name: RegExp): EmbedEvent | null {
    return this.since(index).find((event) => name.test(event.name)) || null;
  }
}
