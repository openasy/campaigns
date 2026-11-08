// The naming rules: how a campaign's utm_campaign is made from its name and dates, and how a tagged link is built.
// Every value is lowercase ASCII with - between words, so "Sonbahar İndirimi" and "sonbahar-indirimi " are one name.
import type { Channel, Config, Naming } from "./config.ts";

const LETTERS: Record<string, string> = { ç: "c", ğ: "g", ı: "i", İ: "i", ö: "o", ş: "s", ü: "u", ß: "ss" };

/** "Sonbahar İndirimi 2026!" is sonbahar-indirimi-2026. */
export function slug(raw: string, max = 64): string {
  const s = [...raw.trim()]
    .map((c) => LETTERS[c] ?? LETTERS[c.toLowerCase()] ?? c)
    .join("")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/, "");
}

/** The utm_campaign the file's naming.campaign makes from a name and the start day. */
export function campaignUtm(n: Naming, name: string, start: string): string {
  const [y, m] = start.split("-");
  const values: Record<string, string> = {
    name: slug(name, n.maxLength),
    year: y!,
    month: m!,
    quarter: `q${Math.floor((Number(m) - 1) / 3) + 1}`,
  };
  const made = n.campaign.replace(/\{([a-z]+)\}/g, (_, k: string) => values[k] ?? "");
  // The name gives way to the rest of the template when the whole is too long.
  if (made.length <= n.maxLength) return made.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  const rest = made.length - values.name!.length;
  const short = values.name!.slice(0, Math.max(1, n.maxLength - rest)).replace(/-+$/, "");
  return n.campaign
    .replace(/\{([a-z]+)\}/g, (_, k: string) => (k === "name" ? short : (values[k] ?? "")))
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Why a utm_campaign breaks the rules, or null when it keeps them. */
export function utmProblem(n: Naming, utm: string): string | null {
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(utm)) return "utm_campaign is lowercase letters, digits, - _ and ., starting with a letter or digit.";
  if (utm.length > n.maxLength) return `utm_campaign is at most ${n.maxLength} characters (naming.max_length).`;
  if (n.pattern && !n.pattern.test(utm)) return `utm_campaign must match naming.pattern, ${n.patternText}.`;
  return null;
}

/** The utm_source values a channel's links may carry. */
export const sourcesOf = (c: Config, ch: Channel) => (ch.sources.length ? ch.sources : c.naming.sources);

/** The destination with the five utm_ parameters, the campaign's replacing any already there. */
export function taggedUrl(destination: string, t: { source: string; medium: string; campaign: string; content: string | null; term: string | null }): string {
  const u = new URL(destination);
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) u.searchParams.delete(k);
  u.searchParams.set("utm_source", t.source);
  u.searchParams.set("utm_medium", t.medium);
  u.searchParams.set("utm_campaign", t.campaign);
  if (t.content) u.searchParams.set("utm_content", t.content);
  if (t.term) u.searchParams.set("utm_term", t.term);
  return u.toString();
}

/**
 * Whether an ad platform's campaign name carries a campaign's utm_campaign: the whole value, with no letter or digit
 * touching it on either side. "autumn-2026 | search" carries autumn-2026; "autumn-2026b" does not.
 */
export function nameCarries(adName: string, utm: string): boolean {
  const s = slug(adName, 500);
  const i = ` ${s.replace(/-/g, " ")} `;
  return i.includes(` ${utm.replace(/[-_.]/g, " ")} `);
}
