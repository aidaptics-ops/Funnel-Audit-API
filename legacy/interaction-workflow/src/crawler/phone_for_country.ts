import {
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  isValidPhoneNumber,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/max";
import examples from "libphonenumber-js/mobile/examples";

export interface PhoneCountryHints {
  iso?: string | null;
  callingCode?: string | null;
  countryName?: string | null;
  inputValue?: string | null;
  extraText?: string | null;
}

export interface DummyPhone {
  country: CountryCode;
  callingCode: string;
  national: string;
  formattedNational: string;
  e164: string;
}

const displayNames = new Intl.DisplayNames(["en"], { type: "region" });

export function resolvePhoneCountry(hints: PhoneCountryHints): CountryCode | null {
  const iso = normalizeIso(hints.iso) || normalizeIso(parseHintsFromText(hints.extraText || "").iso);
  if (iso) return iso;

  const parsedFromInput = countryFromNumber(hints.inputValue);
  const parsedText = parseHintsFromText(
    [hints.countryName, hints.extraText, hints.inputValue].filter(Boolean).join(" "),
  );
  const byName = countryFromName(parsedText.countryName || hints.countryName);
  if (byName) return byName;

  const calling = normalizeCallingCode(parsedText.callingCode || hints.callingCode);
  if (calling) {
    const matches = countriesForCallingCode(calling);
    if (!matches.length) return parsedFromInput;
    if (matches.length === 1) return matches[0] ?? null;
    const named = countryFromName(hints.countryName || parsedText.countryName);
    if (named && matches.includes(named)) return named;
    const fromExtra = matches.find((code) => textMentionsCountry(hints.extraText, code));
    if (fromExtra) return fromExtra;
    return matches[0] ?? parsedFromInput;
  }

  return parsedFromInput;
}

export function dummyPhonesForCountry(country: CountryCode, count = 8): DummyPhone[] {
  const callingCode = String(getCountryCallingCode(country));
  const example = getExampleNumber(country, examples);
  const nationals = new Set<string>();
  if (example?.nationalNumber) nationals.add(example.nationalNumber);

  const base = example?.nationalNumber;
  if (base) {
    for (let seed = 1; seed <= 40 && nationals.size < count; seed += 1) {
      const variant = varyNational(base, seed);
      if (variant !== base && isValidNational(variant, country, callingCode)) {
        nationals.add(variant);
      }
    }
  }

  const phones: DummyPhone[] = [];
  for (const national of nationals) {
    const parsed =
      parsePhoneNumberFromString(national, country) ||
      parsePhoneNumberFromString(`+${callingCode}${national}`);
    if (!parsed?.isValid()) continue;
    phones.push({
      country,
      callingCode: String(parsed.countryCallingCode),
      national: parsed.nationalNumber,
      formattedNational: parsed.formatNational(),
      e164: parsed.number,
    });
    if (phones.length >= count) break;
  }
  return phones;
}

export function valuesToType(phone: DummyPhone): string[] {
  return uniqueStrings([phone.national, phone.formattedNational]);
}

export function parseHintsFromText(text: string): { countryName?: string; callingCode?: string; iso?: string } {
  const blob = (text || "").replace(/\s+/g, " ").trim();
  if (!blob) return {};
  const calling = blob.match(/\+(\d{1,4})\b/);
  const iso = blob.match(/(?:^|[^\w])([A-Z]{2})(?:[^\w]|$)/);
  const named = blob.match(
    /([A-Za-z][A-Za-z .'-]{2,40}?)(?:\s*\([^)]*\))?(?:\s*:\s*|\s+)\+\d/,
  );
  return {
    callingCode: calling?.[1],
    iso: iso?.[1],
    countryName: named?.[1]?.trim(),
  };
}

function isValidNational(national: string, country: CountryCode, callingCode: string): boolean {
  return isValidPhoneNumber(national, country) || isValidPhoneNumber(`+${callingCode}${national}`);
}

function varyNational(base: string, seed: number): string {
  const digits = base.split("");
  const start = Math.max(2, digits.length - 6);
  let n = (seed + 1) * 104729;
  for (let i = start; i < digits.length; i += 1) {
    digits[i] = String(Math.abs(n) % 10);
    n = Math.floor(n / 10) ^ ((i + seed) * 9973);
  }
  return digits.join("");
}

function normalizeIso(raw?: string | null): CountryCode | null {
  const code = (raw || "").trim().toUpperCase();
  if (code.length !== 2) return null;
  return (getCountries() as string[]).includes(code) ? (code as CountryCode) : null;
}

function normalizeCallingCode(raw?: string | null): string | null {
  const digits = (raw || "").replace(/\D/g, "");
  return digits ? digits : null;
}

function countriesForCallingCode(calling: string): CountryCode[] {
  return getCountries().filter((code) => getCountryCallingCode(code) === calling);
}

function countryFromName(raw?: string | null): CountryCode | null {
  const cleaned = (raw || "")
    .replace(/\s*\+\d[\d\s-]*$/g, "")
    .replace(/\(.*?\)/g, " ")
    .replace(/[:|,].*$/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (cleaned.length < 4) return null;

  const exact: CountryCode[] = [];
  const partial: Array<{ code: CountryCode; label: string }> = [];
  for (const code of getCountries()) {
    const label = displayNames.of(code)?.toLowerCase();
    if (!label) continue;
    if (cleaned === label) exact.push(code);
    else if (cleaned.includes(label) || label.includes(cleaned)) {
      partial.push({ code, label });
    }
  }
  if (exact.length) return exact[0] ?? null;
  partial.sort((a, b) => b.label.length - a.label.length);
  return partial[0]?.code ?? null;
}

function countryFromNumber(raw?: string | null): CountryCode | null {
  const value = (raw || "").trim();
  if (!value) return null;
  const parsed = value.includes("+")
    ? parsePhoneNumberFromString(value)
    : parsePhoneNumberFromString(`+${value.replace(/\D/g, "")}`);
  return parsed?.country ?? null;
}

function textMentionsCountry(text: string | null | undefined, code: CountryCode): boolean {
  const label = displayNames.of(code)?.toLowerCase();
  if (!label || !text) return false;
  return text.toLowerCase().includes(label);
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}
