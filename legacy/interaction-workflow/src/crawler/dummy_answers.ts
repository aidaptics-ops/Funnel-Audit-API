import { randomInt } from "node:crypto";
import type { FieldPurpose, TestIdentity } from "../types/index.js";

const JOBS = [
  "Software engineer",
  "Operations manager",
  "Registered nurse",
  "Sales consultant",
  "Small business owner",
  "Product designer",
  "Accountant",
  "Teacher",
];

const SHORT_REPLIES = [
  "Looking to build a more consistent routine.",
  "Want a plan that fits a busy work week.",
  "Need better energy and a sustainable schedule.",
  "Trying to get back in shape after falling off.",
];

export function pickRandom<T>(items: T[]): T {
  if (!items.length) throw new Error("pickRandom called with no items");
  return items[randomInt(items.length)] as T;
}

export function uniqueEmail(base?: string | null): string {
  const fallback = "test@example.com";
  const raw = (base || fallback).trim() || fallback;
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return `test+${stamp()}@example.com`;
  const local = raw.slice(0, at).replace(/\+.*$/, "");
  const domain = raw.slice(at + 1);
  return `${local}+${stamp()}@${domain}`;
}

export function usablePhone(raw?: string | null): string {
  const digits = (raw || "").replace(/\D/g, "");
  const national =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length === 10 && !/^0+$/.test(national) && !/^555/.test(national.slice(3))) {
    return national;
  }
  return "2024567890";
}

export function dummyText(question: string | null, type?: string | null): string {
  const blob = `${question || ""} ${type || ""}`.toLowerCase();
  if (/\b(hour|hours|week)\b/.test(blob) || type === "number") return dummyNumber(question);
  if (/\b(occupation|job|role|title|work)\b/.test(blob)) return pickRandom(JOBS);
  if (/\b(city|town)\b/.test(blob)) return pickRandom(["Austin", "Denver", "Nashville", "Raleigh"]);
  if (/\b(company|business)\b/.test(blob)) return "Northwind Labs";
  if (/\b(website|url)\b/.test(blob)) return "https://example.com";
  if (type === "date" || /\bdate\b/.test(blob)) return dummyDate();
  if (type === "textarea" || /\b(tell|describe|why|goal|note|comment)\b/.test(blob)) {
    return pickRandom(SHORT_REPLIES);
  }
  return pickRandom(["Ready to start", "Looking for a better plan", "Want more consistency"]);
}

export function dummyNumber(question: string | null, min = 20, max = 55): string {
  const blob = (question || "").toLowerCase();
  if (/\bage\b/.test(blob)) return String(randomInt(25, 45));
  if (/\b(hour|hours|week)\b/.test(blob)) return String(randomInt(25, 50));
  const lo = Number.isFinite(min) ? min : 1;
  const hi = Number.isFinite(max) && max > lo ? max : lo + 10;
  return String(randomInt(lo, hi + 1));
}

export function dummyDate(): string {
  const start = new Date();
  start.setDate(start.getDate() + randomInt(3, 18));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
}

export function valueForIdentity(purpose: FieldPurpose, identity: TestIdentity): string | null {
  switch (purpose) {
    case "email":
      return identity.email || null;
    case "phone":
      return usablePhone(identity.phone);
    case "first_name":
      return identity.first_name || "Alex";
    case "last_name":
      return identity.last_name || "Taylor";
    case "full_name":
      return [identity.first_name || "Alex", identity.last_name || "Taylor"].join(" ");
    default:
      return null;
  }
}

export function prepareIdentity(identity?: TestIdentity): TestIdentity {
  return {
    first_name: identity?.first_name || "Alex",
    last_name: identity?.last_name || "Taylor",
    email: uniqueEmail(identity?.email),
    phone: usablePhone(identity?.phone),
  };
}

function stamp(): string {
  return `${Date.now().toString(36)}${randomInt(100, 999)}`;
}
