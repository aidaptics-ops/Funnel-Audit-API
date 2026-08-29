const UNDERSTAND = /i understand/i;
const DECLINE =
  /don'?t intend|cannot attend|please cancel|won'?t (be able to )?show|no,? i don'?t/i;

export function isCalendlyDeclineChoice(text: string): boolean {
  return DECLINE.test(normalizeChoice(text));
}

export function preferredCalendlyChoice(labels: string[]): string | null {
  const cleaned = labels.map(normalizeChoice).filter(Boolean);
  if (!cleaned.length) return null;
  const understand = cleaned.find((text) => UNDERSTAND.test(text));
  if (understand) return understand;
  const usable = cleaned.filter((text) => !isCalendlyDeclineChoice(text));
  return usable[0] ?? cleaned[0] ?? null;
}

function normalizeChoice(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
