import type { FieldPurpose } from "../types/index.js";

const PATTERNS: Array<{ purpose: FieldPurpose; tests: RegExp[] }> = [
  { purpose: "email", tests: [/e-?mail/, /correo/, /autocomplete:\s*email/] },
  { purpose: "first_name", tests: [/first[_\s-]*name/, /\bfname\b/, /given[_\s-]*name/, /prenom/, /forename/] },
  { purpose: "last_name", tests: [/last[_\s-]*name/, /\blname\b/, /family[_\s-]*name/, /surname/, /apellido/] },
  { purpose: "full_name", tests: [/full[_\s-]*name/, /^name$/, /\byour name\b/, /nombre completo/] },
  { purpose: "phone", tests: [/phone/, /mobile/, /tel/, /whats?app/, /cell/] },
  { purpose: "password", tests: [/password/, /passwd/, /passcode/] },
  { purpose: "consent", tests: [/agree/, /terms/, /privacy/, /consent/, /opt[_\s-]*in/, /subscribe/, /gdpr/] },
  { purpose: "search", tests: [/^q$/, /\bsearch\b/, /\bquery\b/] },
  {
    purpose: "payment",
    tests: [/card/, /cc-/, /cvv/, /cvc/, /expir/, /billing/, /zipcode/, /postal/, /credit/],
  },
  { purpose: "message", tests: [/message/, /comment/, /notes?$/, /tell us/, /anything else/] },
];

export function inferFieldPurpose(input: {
  name?: string | null;
  id?: string | null;
  type?: string | null;
  label?: string | null;
  placeholder?: string | null;
  autocomplete?: string | null;
}): FieldPurpose {
  const type = (input.type || "").toLowerCase();
  if (type === "email") return "email";
  if (type === "tel") return "phone";
  if (type === "password") return "password";
  if (type === "search") return "search";
  if (type === "checkbox" || type === "radio") {
    const blob = blobOf(input);
    if (PATTERNS.find((p) => p.purpose === "consent")?.tests.some((re) => re.test(blob))) {
      return "consent";
    }
  }

  const autocomplete = (input.autocomplete || "").toLowerCase();
  if (autocomplete === "email") return "email";
  if (autocomplete === "tel" || autocomplete === "tel-national") return "phone";
  if (autocomplete === "given-name") return "first_name";
  if (autocomplete === "family-name") return "last_name";
  if (autocomplete === "name") return "full_name";
  if (autocomplete === "username") return "email";
  if (autocomplete.includes("cc-") || autocomplete === "email") {
    if (autocomplete.startsWith("cc-")) return "payment";
  }

  const blob = blobOf(input);
  for (const { purpose, tests } of PATTERNS) {
    if (tests.some((re) => re.test(blob))) return purpose;
  }
  return "other";
}

function blobOf(input: {
  name?: string | null;
  id?: string | null;
  type?: string | null;
  label?: string | null;
  placeholder?: string | null;
  autocomplete?: string | null;
}): string {
  return [
    input.name,
    input.id,
    input.label,
    input.placeholder,
    input.autocomplete ? `autocomplete:${input.autocomplete}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
