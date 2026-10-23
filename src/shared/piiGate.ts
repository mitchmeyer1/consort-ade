/**
 * A mechanical check for structural PII/PHI in text: identifiers with a fixed, verifiable shape
 * that a regex plus a checksum or an adjacent label can assert with high precision (SSN, payment
 * card, Medicare beneficiary identifier, medical record number, email, phone, labelled date of
 * birth, street address), and a warning for text that looks like pasted rows. A port of the
 * organisation's pii-gate, used by cli/covered.ts on the covered analyst's answer and by
 * redact.ts on everything the CLI sends. Person names and payer-specific member numbers have no
 * fixed shape and are out of scope here; redact.ts masks names.
 *
 * Two postures. `release` is for text leaving a covered context: every detector, no exemptions,
 * because a false block costs one retry and a miss is permanent. `commit` is for text a person
 * or an agent wrote into code: published placeholders and documentation addresses are exempt,
 * so synthetic fixtures do not train anyone to switch the guard off. A finding carries a masked
 * shape, never the matched text, so a report about it is safe to post.
 */

export type Posture = "release" | "commit";
export type PiiCategory = "ssn" | "card" | "mbi" | "mrn" | "email" | "phone" | "phone-anchored" | "dob" | "address" | "rows";
export type PiiSpan = { category: PiiCategory; start: number; end: number; tier: "block" | "warn" };
export type PiiFinding = { category: PiiCategory; count: number; firstOffset: number; shape: string; tier: "block" | "warn" };
/** `clean`: no block-tier finding; `highPrecision`: a block finding strong enough to act on as fact */
export type PiiScan = { findings: PiiFinding[]; highPrecision: boolean; clean: boolean };
export type PiiOptions = { internalEmailDomains?: string[]; publishedPhones?: string[] };

/** each requires a checksum, a positional format or an adjacent label, so a hit is very unlikely to be anything else */
export const HIGH_PRECISION: ReadonlySet<PiiCategory> = new Set(["ssn", "card", "mbi", "mrn", "dob", "phone-anchored"]);
export const DEFAULT_INTERNAL_EMAIL_DOMAINS = ["alignedmarketplace.com"];

export function scanPii(text: string, posture: Posture, o: PiiOptions = {}): PiiScan {
  const spans = piiSpans(text, posture, o);
  const findings: PiiFinding[] = [];
  for (const span of spans) {
    const known = findings.find((f) => f.category === span.category);
    if (known) { known.count++; continue; }
    findings.push({ category: span.category, count: 1, firstOffset: span.start, shape: maskShape(text.slice(span.start, span.end)), tier: span.tier });
  }
  const blocking = findings.filter((f) => f.tier === "block");
  return { findings, highPrecision: blocking.some((f) => HIGH_PRECISION.has(f.category)), clean: !blocking.length };
}

/** every match with its category, in text order; the caller can redact as well as count */
export function piiSpans(text: string, posture: Posture, o: PiiOptions = {}): PiiSpan[] {
  if (!text) return [];
  const placeholders = posture === "commit";
  const internal = (o.internalEmailDomains ?? DEFAULT_INTERNAL_EMAIL_DOMAINS).map((d) => d.toLowerCase());
  const published = new Set((o.publishedPhones ?? []).map((p) => p.replace(/\D/g, "").slice(-10)));
  const block = (category: PiiCategory, found: [number, number][]) => found.map(([start, end]): PiiSpan => ({ category, start, end, tier: "block" }));
  const spans: PiiSpan[] = [
    ...block("ssn", [...matches(SSN_DELIMITED, text), ...matches(SSN_LABELLED, text)].filter(([s, e]) => !(placeholders && cannotBelongToAPerson(text.slice(s, e).replace(/\D/g, ""))))),
    ...block("card", cardRuns(text).filter((r) => !(placeholders && isPlaceholderCard(r.digits))).map((r) => [r.start, r.end] as [number, number])),
    ...block("mbi", matches(MBI_CANDIDATE, text).filter(([s, e]) => isMedicareBeneficiaryIdentifier(text.slice(s, e).replace(/-/g, "")))),
    ...block("mrn", matches(MEDICAL_RECORD_NUMBER, text)),
    ...block("email", emailMatches(text).filter((m) => !emailIsExempt(m.local, m.domain, internal, placeholders)).map((m) => [m.start, m.end] as [number, number])),
    ...block("phone", matches(TELEPHONE, text).filter(([s, e]) => {
      const digits = text.slice(s, e).replace(/\D/g, "").slice(-10);
      return !TOLL_FREE.includes(digits.slice(0, 3)) && !published.has(digits) && !(placeholders && isFictionalTelephone(digits));
    })),
    ...block("phone-anchored", [...matches(TELEPHONE_E164, text), ...matches(TELEPHONE_LABELLED, text)].filter(([s, e]) => !(placeholders && isFictionalTelephone(text.slice(s, e).replace(/\D/g, ""))))),
    ...block("dob", matches(DATE_OF_BIRTH, text)),
    ...block("address", matches(STREET_ADDRESS, text)),
    ...delimitedRowBlocks(text).map(([start, end]): PiiSpan => ({ category: "rows", start, end, tier: "warn" })),
  ];
  return spans.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** replace every block-tier span with [REDACTED:<category>]; overlapping spans merge */
export function redactSpans(text: string, spans: PiiSpan[], replace = (s: PiiSpan) => `[REDACTED:${s.category}]`): string {
  let out = "", cursor = 0;
  for (const span of spans.filter((s) => s.tier === "block")) {
    if (span.end <= cursor) continue;
    out += text.slice(cursor, Math.max(cursor, span.start)) + (span.start >= cursor ? replace(span) : "");
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/** the structural skeleton of a match: digit N, letter A, whitespace _, the rest kept; capped at 40 */
export const maskShape = (s: string) => {
  const shape = s.replace(/[0-9]/g, "N").replace(/\p{L}/gu, "A").replace(/\s/g, "_");
  return shape.length > 40 ? `${shape.slice(0, 40)}…` : shape;
};

/** "ssn ×1, email ×2" for logs and messages; block findings only */
export const categoryLine = (scan: PiiScan) => scan.findings.filter((f) => f.tier === "block").map((f) => `${f.category} ×${f.count}`).join(", ");
/** "ssn:NNN-NN-NNNN" for logs: the original digits and letters are gone, but a masked address keeps its @ and dots and still reads as one to a pattern filter, so posted text carries categories only */
export const shapeLine = (scan: PiiScan) => scan.findings.filter((f) => f.tier === "block").map((f) => `${f.category}:${f.shape}`).join(" ");

export function luhn(digits: string): boolean {
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let value = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { value *= 2; if (value > 9) value -= 9; }
    total += value;
  }
  return total % 10 === 0;
}

const matches = (pattern: RegExp, text: string): [number, number][] => [...text.matchAll(pattern)].map((m) => [m.index!, m.index! + m[0].length]);

const SSN_DELIMITED = /(?<![\d-])\d{3}[-\s]\d{2}[-\s]\d{4}(?![\d-])/g;
const SSN_LABELLED = /\b(?:ssn|social\s*security(?:\s*(?:number|no\.?|#))?)\b[^0-9\n]{0,20}\d{9}(?!\d)/gi;
// An MRN has no canonical shape, so the label on the same line is the whole signal.
const MEDICAL_RECORD_NUMBER = /\b(?:mrn|medical\s+record\s+(?:number|no\.?|#))\b[^0-9\n]{0,10}\d{4,}/gi;
const MBI_CANDIDATE = /\b[0-9A-Z]{2}[0-9A-Z-]{9,11}\b/g;
const MEDICARE_BENEFICIARY_LETTERS = "ACDEFGHJKMNPQRTUVWXY";
// A bare run of ten digits is indistinguishable from an integer key: a parenthesised area code or a separator is required.
const TELEPHONE = /(?<![\d-])(?:(?:\+?1|001)[ .-]?)?(?:\([2-9]\d{2}\)[ .-]?[2-9]\d{2}[ .-]?\d{4}|[2-9]\d{2}[ .-][2-9]\d{2}[ .-]\d{4})(?!\d)/g;
// E.164 and a number beside a phone label carry their own evidence, so they need no separator; the label lookbehind excludes only letters so snake_case column names still match
const TELEPHONE_E164 = /(?<![\w+])\+1[2-9]\d{2}[2-9]\d{6}(?!\d)|(?<![\w+])\+[2-9]\d{7,14}(?!\d)/g;
const TELEPHONE_LABELLED = /(?<![A-Za-z])(?:phone|mobile|cell|telephone|tel|fax)(?:[_\s-]?(?:number|no\.?|#))?\b[^0-9\n]{0,15}(?:\+?1[ .-]?)?[2-9]\d{9}(?!\d)/gi;
const TOLL_FREE = ["800", "833", "844", "855", "866", "877", "888"];
const DATE_OF_BIRTH = /\b(?:d\.?o\.?b\.?|date\s+of\s+birth|birth\s*date|birthday)\b[^0-9\n]{0,20}\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/gi;
const EMAIL = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost)\b/g;
const DOCUMENTATION_EMAIL_DOMAINS = ["example.com", "example.org", "example.net", "example.edu", "localhost", "invalid", "test", "example", "local"];
const ROLE_EMAIL_LOCAL_PARTS = ["noreply", "no-reply", "donotreply", "do-not-reply", "notifications", "users.noreply", "support", "abuse", "postmaster"];

// Luhn alone passes about one digit run in ten, and claims data is full of 15- and 16-digit control numbers: a run must also carry an issuer prefix at a length that issuer uses.
const CARD_CANDIDATE = /\b(?:\d[ -]?){11,18}\d\b/g;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const CARD_ISSUERS: [RegExp, number[]][] = [
  [/^4/, [13, 16, 19]],
  [/^(?:5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720))/, [16]],
  [/^3[47]/, [15]],
  [/^(?:6011|65|64[4-9])/, [16, 17, 18, 19]],
  [/^35(?:2[89]|[3-8]\d)/, [16, 17, 18, 19]],
  [/^3(?:0[0-5]|095|[689])/, range(14, 19)],
  [/^62/, range(16, 19)],
  [/^(?:5018|5020|5038|5893|6304|639|6759|676[123])/, range(12, 19)],
];
// The processors' published test numbers: Luhn-valid with a real issuer prefix by construction, so only a list tells them apart. Kept as digit groups so no card-shaped literal sits in source.
const PUBLISHED_TEST_CARDS = new Set([
  ["4242", "4242", "4242", "4242"], ["4000", "0566", "5566", "5556"], ["4111", "1111", "1111", "1111"], ["4012", "8888", "8888", "1881"],
  ["5555", "5555", "5555", "4444"], ["5200", "8282", "8282", "8210"], ["5105", "1051", "0510", "5100"], ["2223", "0031", "2200", "3222"],
  ["3782", "8224", "6310", "005"], ["3714", "4963", "5398", "431"], ["6011", "1111", "1111", "1117"], ["6011", "0009", "9013", "9424"],
  ["3056", "9300", "0902", "0004"], ["3622", "7206", "2716", "67"], ["3566", "0020", "2036", "0505"], ["6200", "0000", "0000", "0005"],
].map((groups) => groups.join("")));

function cardRuns(text: string): { start: number; end: number; digits: string }[] {
  return [...text.matchAll(CARD_CANDIDATE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, digits: m[0].replace(/[ -]/g, "") }))
    .filter((r) => luhn(r.digits) && CARD_ISSUERS.some(([prefix, lengths]) => lengths.includes(r.digits.length) && prefix.test(r.digits)));
}
const ascending = "01234567890123456789", descending = "98765432109876543210";
const isPlaceholderCard = (digits: string) => PUBLISHED_TEST_CARDS.has(digits) || new Set(digits).size === 1 || ascending.includes(digits) || descending.includes(digits);
/** values no Social Security Number can take, so no person holds one */
const cannotBelongToAPerson = (digits: string) => digits.length === 9 && (new Set(digits).size === 1 || ascending.includes(digits) || descending.includes(digits) || /^(?:000|666|9)/.test(digits));
// 555-0100 through 555-0199 is the block NANP reserves for fiction; other 555 numbers are assignable and stay in scope
const isFictionalTelephone = (digits: string) => digits.length >= 7 && /^55501\d{2}$/.test(digits.slice(-7));

function isMedicareBeneficiaryIdentifier(c: string): boolean {
  if (c.length !== 11 || !"123456789".includes(c[0])) return false;
  const digit = (i: number) => /\d/.test(c[i]);
  const letter = (i: number) => MEDICARE_BENEFICIARY_LETTERS.includes(c[i]);
  return [0, 3, 6, 9, 10].every(digit) && [1, 4, 7, 8].every(letter) && [2, 5].every((i) => digit(i) || letter(i));
}

function emailMatches(text: string): { start: number; end: number; local: string; domain: string }[] {
  return [...text.matchAll(EMAIL)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, local: m[1], domain: m[2].toLowerCase() }));
}
function emailIsExempt(local: string, domain: string, internal: string[], source: boolean): boolean {
  const under = (allowed: string) => domain === allowed || domain.endsWith(`.${allowed}`);
  if (internal.some(under)) return true;
  if (!source) return false;
  return DOCUMENTATION_EMAIL_DOMAINS.some(under) || under("github.com") || ROLE_EMAIL_LOCAL_PARTS.some((p) => local.toLowerCase().startsWith(p));
}

/** three or more consecutive tab- or comma-delimited lines of four or more fields: rows pasted verbatim; pipes are left out so a Markdown table of aggregates does not count */
function delimitedRowBlocks(text: string): [number, number][] {
  const blocks: [number, number][] = [];
  let offset = 0, run = 0, runStart = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const stripped = line.trim();
    const fields = Math.max(stripped.split("\t").length, stripped.split(",").length);
    if (stripped && fields >= 4) { if (!run) runStart = offset; run++; }
    else { if (run >= 3) blocks.push([runStart, offset]); run = 0; }
    offset += line.length;
  }
  if (run >= 3) blocks.push([runStart, offset]);
  return blocks;
}

// USPS Publication 28 Appendix C1 street types, every spelling it lists except the two-letter forms, which collide with ordinary words.
const STREET_SUFFIXES = [
  "allee", "alley", "ally", "aly", "anex", "annex", "annx", "anx", "arc", "arcade", "ave", "aven",
  "avenu", "avenue", "avn", "avnue", "bayoo", "bayou", "bch", "beach", "bend", "bgs", "blf",
  "blfs", "bluf", "bluff", "bluffs", "blvd", "bnd", "bot", "bottm", "bottom", "boul", "boulevard",
  "boulv", "branch", "brdge", "brg", "bridge", "brk", "brks", "brnch", "brook", "brooks", "btm",
  "burg", "burgs", "byp", "bypa", "bypas", "bypass", "byps", "byu", "camp", "canyn", "canyon",
  "cape", "causeway", "causway", "cen", "cent", "center", "centers", "centr", "centre", "cir",
  "circ", "circl", "circle", "circles", "cirs", "clb", "clf", "clfs", "cliff", "cliffs", "club",
  "cmn", "cmp", "cnter", "cntr", "cnyn", "common", "cor", "corner", "corners", "cors", "course",
  "court", "courts", "cove", "coves", "cpe", "crcl", "crcle", "crecent", "creek", "cres",
  "crescent", "cresent", "crest", "crk", "crossing", "crossroad", "crscnt", "crse", "crsent",
  "crsnt", "crssing", "crssng", "crst", "crt", "cswy", "ctr", "ctrs", "cts", "curv", "curve",
  "cvs", "cyn", "dale", "dam", "div", "divide", "driv", "drive", "drives", "drs", "drv", "dvd",
  "est", "estate", "estates", "ests", "exp", "expr", "express", "expressway", "expw", "expy",
  "ext", "extension", "extensions", "extn", "extnsn", "exts", "fall", "falls", "ferry", "field",
  "fields", "flat", "flats", "fld", "flds", "fls", "flt", "flts", "ford", "fords", "forest",
  "forests", "forg", "forge", "forges", "fork", "forks", "fort", "frd", "frds", "freeway",
  "freewy", "frg", "frgs", "frk", "frks", "frry", "frst", "frt", "frway", "frwy", "fry", "fwy",
  "garden", "gardens", "gardn", "gateway", "gatewy", "gatway", "gdn", "gdns", "glen", "glens",
  "gln", "glns", "grden", "grdn", "grdns", "green", "greens", "grn", "grns", "grov", "grove",
  "groves", "grv", "grvs", "gtway", "gtwy", "harb", "harbor", "harbors", "harbr", "haven", "havn",
  "hbr", "hbrs", "height", "heights", "hgts", "highway", "highwy", "hill", "hills", "hiway",
  "hiwy", "hllw", "hls", "hollow", "hollows", "holw", "holws", "hrbor", "hts", "hvn", "hway",
  "hwy", "inlet", "inlt", "island", "islands", "isle", "isles", "islnd", "islnds", "iss", "jct",
  "jction", "jctn", "jctns", "jcts", "junction", "junctions", "junctn", "juncton", "key", "keys",
  "knl", "knls", "knol", "knoll", "knolls", "kys", "lake", "lakes", "land", "landing", "lane",
  "lanes", "lck", "lcks", "ldg", "ldge", "lgt", "lgts", "light", "lights", "lks", "lndg", "lndng",
  "loaf", "lock", "locks", "lodg", "lodge", "loop", "loops", "mall", "manor", "manors", "mdw",
  "mdws", "meadow", "meadows", "medows", "mews", "mill", "mills", "mission", "missn", "mls", "mnr",
  "mnrs", "mnt", "mntain", "mntn", "mntns", "motorway", "mount", "mountain", "mountains",
  "mountin", "msn", "mssn", "mtin", "mtn", "mtns", "mtwy", "nck", "neck", "opas", "orch",
  "orchard", "orchrd", "oval", "overpass", "ovl", "park", "parks", "parkway", "parkways", "parkwy",
  "pass", "passage", "path", "paths", "pike", "pikes", "pine", "pines", "pkway", "pkwy", "pkwys",
  "pky", "place", "plain", "plaines", "plains", "plaza", "pln", "plns", "plz", "plza", "pne",
  "pnes", "point", "points", "port", "ports", "prairie", "prarie", "prk", "prr", "prt", "prts",
  "psge", "pts", "rad", "radial", "radiel", "radl", "ramp", "ranch", "ranches", "rapid", "rapids",
  "rdg", "rdge", "rdgs", "rds", "rest", "ridge", "ridges", "riv", "river", "rivr", "rnch", "rnchs",
  "road", "roads", "route", "row", "rpd", "rpds", "rst", "rte", "rue", "run", "rvr", "shl", "shls",
  "shoal", "shoals", "shoar", "shoars", "shore", "shores", "shr", "shrs", "skwy", "skyway", "smt",
  "spg", "spgs", "spng", "spngs", "spring", "springs", "sprng", "sprngs", "spur", "spurs", "sqr",
  "sqre", "sqrs", "sqs", "squ", "square", "squares", "sta", "station", "statn", "stn", "str",
  "stra", "strav", "strave", "straven", "stravenue", "stravn", "stream", "street", "streets",
  "streme", "strm", "strt", "strvn", "strvnue", "sts", "sumit", "sumitt", "summit", "ter", "terr",
  "terrace", "throughway", "tpk", "tpke", "trace", "traces", "track", "tracks", "trafficway",
  "trail", "trails", "trak", "trce", "trfy", "trk", "trks", "trl", "trls", "trnpk", "trpk", "trwy",
  "tunel", "tunl", "tunls", "tunnel", "tunnels", "tunnl", "turnpike", "turnpk", "underpass",
  "union", "unions", "uns", "upas", "valley", "valleys", "vally", "vdct", "via", "viadct",
  "viaduct", "view", "views", "vill", "villag", "village", "villages", "ville", "villg",
  "villiage", "vis", "vist", "vista", "vlg", "vlgs", "vlly", "vly", "vlys", "vst", "vsta", "vws",
  "walk", "walks", "wall", "way", "ways", "well", "wells", "wls", "xing", "xrd"
];
// A capitalised name token must precede the suffix, or "reduced 12 claims via dedup" reads as an address; longest suffix first so "street" is not shadowed by "st".
const STREET_SUFFIX_FORMS = [...new Set(STREET_SUFFIXES.flatMap((s) => [s[0].toUpperCase() + s.slice(1), s.toUpperCase()]))].sort((a, b) => b.length - a.length);
const STREET_ADDRESS = new RegExp(String.raw`\b\d{1,6}\s+(?:[A-Z][A-Za-z0-9.'-]*\s+){1,4}(?:${STREET_SUFFIX_FORMS.join("|")})s?\b\.?`, "g");
