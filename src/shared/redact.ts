/**
 * Nothing personal reaches Slack. Every message the CLI sends goes through redactPii (cli/slack.ts):
 * people's names, emails, phone numbers, street addresses, SSNs and labelled patient details
 * (DOB, MRN, "patient: …") become ****. Slack mentions (<@U…>), @handles, GitHub logins, URLs
 * and code identifiers are left alone. It is a pattern filter, so agents are also told not to
 * write PII (headless.ts HEADLESS_RULES); this catches what slips through. The PII gate's shape
 * checks (piiGate.ts: payment cards, Medicare beneficiary identifiers, E.164 and labelled phones)
 * run first; the broader patterns below over-mask on purpose, since a masked word costs nothing.
 */
import { piiSpans, redactSpans } from "./piiGate.ts";

export const MASK = "****";

// common US first names; a name is one of these followed by a capitalised word ("Will Lerner", "MARY SMITH")
const FIRST_NAMES = `James John Robert Michael William David Richard Joseph Thomas Charles Christopher Daniel Matthew Anthony Mark Donald Steven Paul Andrew Joshua Kenneth Kevin Brian George Timothy Ronald Edward Jason Jeffrey Ryan Jacob Gary Nicholas Eric Jonathan Stephen Larry Justin Scott Brandon Benjamin Samuel Gregory Alexander Frank Patrick Raymond Jack Dennis Jerry Tyler Aaron Jose Adam Nathan Henry Douglas Zachary Peter Kyle Ethan Walter Noah Jeremy Christian Keith Roger Terry Gerald Harold Sean Austin Carl Arthur Lawrence Dylan Jesse Jordan Bryan Billy Joe Bruce Gabriel Logan Albert Willie Alan Juan Wayne Elijah Randy Roy Vincent Ralph Eugene Russell Bobby Mason Philip Louis Mitch Mitchell Will Bill Bob Jim Jimmy Tom Tommy Mike Dave Dan Danny Matt Chris Nick Steve Ben Sam Greg Alex Pete Joey Tony Rick Rich Ken Ted Jeff Josh Jake Luke Liam Oliver Lucas Owen Caleb Hunter Connor Evan Ian Isaac Luis Carlos Miguel Diego Mary Patricia Jennifer Linda Elizabeth Barbara Susan Jessica Sarah Karen Lisa Nancy Betty Margaret Sandra Ashley Kimberly Emily Donna Michelle Carol Amanda Dorothy Melissa Deborah Stephanie Rebecca Sharon Laura Cynthia Kathleen Amy Angela Shirley Anna Brenda Pamela Emma Nicole Helen Samantha Katherine Christine Debra Rachel Carolyn Janet Catherine Maria Heather Diane Ruth Julie Olivia Joyce Virginia Victoria Kelly Lauren Christina Joan Evelyn Judith Megan Andrea Cheryl Hannah Jacqueline Martha Gloria Teresa Ann Sara Madison Frances Kathryn Janice Jean Abigail Alice Judy Sophia Grace Denise Amber Doris Marilyn Danielle Beverly Isabella Theresa Diana Natalie Brittany Charlotte Marie Kayla Alexis Lori Ava Mia Chloe Ella Lily Zoe Kate Katie Jen Jenny Liz Beth Sue Kim Meg Becky Tina Gina Nina Erin Molly Holly Jill Dana Tara Leah Paige Claire Jane Lucy Ruby Rose Hazel Ivy Nora Stella Violet Aria Layla Riley Avery Morgan Taylor Casey Jamie Robin Lee Leslie Carmen Rosa Ana Elena Sofia Valeria Camila Lucia Isabel Gabriela`.split(/\s+/);
const NAME_WORD = String.raw`(?:[A-Z][a-z'’-]+|[A-Z][A-Z'’-]+)`;
const NAMES = new RegExp(String.raw`\b(?:${FIRST_NAMES.flatMap((n) => [n, n.toUpperCase()]).join("|")})\s+(?:[A-Z]\.\s+)?${NAME_WORD}\b`, "g");
const TITLED = new RegExp(String.raw`\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof)\.?\s+${NAME_WORD}(?:\s+${NAME_WORD})?`, "g");
// "patient: Jane Q Doe", "member name - John", "DOB: 01/02/1980", "MRN 12345"
const LABELLED = /\b(?:patient(?:'s)?(?:\s+name)?|member(?:'s)?\s+name|full\s+name|first\s+name|last\s+name|legal\s+name|caregiver|guardian|dob|d\.o\.b\.|date\s+of\s+birth|birth\s*date|mrn|medical\s+record(?:\s+number)?|ssn|social\s+security(?:\s+number)?|insurance\s+id|member\s+id|policy\s+number)\s*[:=#-]\s*([^\n,;|<>()]{1,60})/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w/.-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?:\s*(?:x|ext\.?)\s*\d{1,5})?(?![\w/-])/g;
const SSN = /(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/g;
const STREET = String.raw`(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Parkway|Pkwy|Circle|Cir|Terrace|Ter|Highway|Hwy|Trail|Trl|Square|Sq|Loop|Alley|Pike)`;
const ADDRESS = new RegExp(String.raw`\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z0-9][A-Za-z0-9'’-]*\.?\s+){1,4}${STREET}\b\.?(?:,?\s*(?:Apt|Apartment|Suite|Ste|Unit|#)\.?\s*[\w-]+)?(?:,\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})?(?:,?\s*[A-Z]{2})?(?:\s+\d{5}(?:-\d{4})?)?`, "g");
const PO_BOX = /\bP\.?\s?O\.?\s+Box\s+\d+\b/gi;

const GATE_SHAPES = new Set(["card", "mbi", "phone-anchored"]);

/** Slack tokens to keep as they are: mentions, dates, and the URL half of a link (its label is still checked) */
const KEEP = /<(?:[@#!][^>]*|https?:[^|>]*)(?=[|>])/g;

export function redactPii(text: string): string {
  if (!text) return text;
  const kept: string[] = [];
  let out = text.replace(KEEP, (m) => { kept.push(m); return `\u0000${kept.length - 1}\u0000`; });
  // only the shapes the patterns below miss; a labelled phone keeps its label, like the labelled values do
  const before = out;
  out = redactSpans(before, piiSpans(before, "release").filter((s) => GATE_SHAPES.has(s.category)), (s) => (s.category === "phone-anchored" ? before.slice(s.start, s.end).replace(/\+?\d[\d .-]*\d/, MASK) : MASK));
  out = out
    .replace(EMAIL, MASK)
    .replace(SSN, MASK)
    .replace(PHONE, MASK)
    .replace(ADDRESS, MASK)
    .replace(PO_BOX, MASK)
    .replace(LABELLED, (m, value: string) => m.slice(0, m.length - value.length) + MASK)
    .replace(TITLED, MASK)
    .replace(NAMES, MASK);
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => kept[Number(i)]);
}
