export const FORM_EMBED_HOSTS =
  /typeform\.com|form\.typeform|jotform\.com|forms\.gle|docs\.google\.com\/forms|google\.com\/forms|tally\.so|fillout\.com|paperform\.co|leadconnectorhq\.com|msgsndr\.com|gohighlevel\.com|form-builder\.gohighlevel/i;

export const CALENDAR_EMBED_HOSTS =
  /calendly\.com|cal\.com|acuityscheduling\.com|tidycal\.com|hubspot\.com\/meetings|calendar\.google\.com|outlook\.office|savvycal\.com|oncehub\.com|scheduleonce\.com|youcanbook\.me|appointlet\.com|koalendar\.com|zcal\.co|chilipiper\.com|leadconnectorhq\.com\/widget\/(?:booking|bookings)|msgsndr\.com\/widget\/(?:booking|bookings)/i;

export function isFormEmbedSrc(src: string | null | undefined): boolean {
  if (!src) return false;
  return FORM_EMBED_HOSTS.test(src);
}

export function isCalendarEmbedSrc(src: string | null | undefined): boolean {
  if (!src) return false;
  return CALENDAR_EMBED_HOSTS.test(src);
}

export function embedProvider(src: string | null | undefined): string | null {
  if (!src) return null;
  const s = src.toLowerCase();
  if (s.includes("typeform")) return "typeform";
  if (s.includes("jotform")) return "jotform";
  if (s.includes("tally.so")) return "tally";
  if (s.includes("fillout.com")) return "fillout";
  if (s.includes("paperform")) return "paperform";
  if (s.includes("google.com/forms") || s.includes("docs.google.com/forms") || s.includes("forms.gle")) {
    return "google_forms";
  }
  if (s.includes("leadconnector") || s.includes("msgsndr") || s.includes("gohighlevel")) {
    return /widget\/(?:booking|bookings)/.test(s) ? "gohighlevel_calendar" : "gohighlevel";
  }
  if (s.includes("calendly")) return "calendly";
  if (s.includes("cal.com")) return "cal.com";
  if (s.includes("acuity")) return "acuity";
  if (s.includes("tidycal")) return "tidycal";
  if (s.includes("hubspot.com/meetings")) return "hubspot_meetings";
  if (s.includes("savvycal")) return "savvycal";
  if (s.includes("oncehub") || s.includes("scheduleonce")) return "oncehub";
  if (s.includes("youcanbook.me")) return "youcanbookme";
  if (s.includes("appointlet")) return "appointlet";
  if (s.includes("koalendar")) return "koalendar";
  if (s.includes("zcal.co")) return "zcal";
  if (s.includes("chilipiper")) return "chilipiper";
  if (s.includes("calendar.google.com")) return "google_calendar";
  return null;
}

/** Provider name when the URL is a scheduling/booking surface, else null. */
export function schedulerProvider(src: string | null | undefined): string | null {
  if (!isCalendarEmbedSrc(src)) return null;
  return embedProvider(src) || "scheduler";
}
