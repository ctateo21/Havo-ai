import { load } from "cheerio";
const UA = "Mozilla/5.0 (compatible; HavoPropertyTax/1.0; +https://havofl.com)";
/** Per-lookup cookie jar; hidden WebForms controls are copied verbatim. */
export class CountySession {
  private cookies = new Map<string, string>();
  async request(url: string, body?: URLSearchParams | string, json = false): Promise<string> {
    for (let redirects = 0; redirects < 8; redirects++) {
      const r = await fetch(url, {
        method: body === undefined ? "GET" : "POST", redirect: "manual",
        headers: { "User-Agent": UA, Cookie: [...this.cookies].map(([k,v]) => `${k}=${v}`).join("; "),
          ...(body !== undefined ? { "Content-Type": json ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded" } : {}) },
        ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(30_000),
      });
      for (const c of r.headers.getSetCookie()) {
        const [pair] = c.split(";"); const p = pair.indexOf("=");
        if (p > 0) this.cookies.set(pair.slice(0,p), pair.slice(p+1));
      }
      if ([301,302,303,307,308].includes(r.status)) {
        const next = r.headers.get("location");
        if (!next) throw new Error("County session redirect missing");
        const target = new URL(next, url);
        if (target.protocol !== "https:" || target.hostname !== new URL(url).hostname) throw new Error("Unexpected county redirect");
        url = target.href;
        if (![307,308].includes(r.status)) body = undefined;
        continue;
      }
      if (!r.ok) throw new Error(`County page unavailable (${r.status})`);
      return r.text();
    }
    throw new Error("County session could not be established");
  }
}
export function webForm(html: string, values: Record<string, string | null>): URLSearchParams {
  const $ = load(html), form = new URLSearchParams();
  $("input[type=hidden][name]").each((_, el) => { form.set($(el).attr("name")!, $(el).val() as string || ""); });
  for (const [suffix, value] of Object.entries(values)) {
    const el = $("[name]").filter((_, e) => ($(e).attr("name") || "").split("$").at(-1) === suffix).first();
    const name = el.attr("name");
    if (!name) throw new Error(`County form control missing: ${suffix}`);
    if (value !== null) form.set(name, value);
    else form.delete(name);
  }
  return form;
}
export function moneyCents(value: string): number {
  const text = value.replace(/[$,\s*]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("County money value could not be parsed");
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error("County money value out of range");
  return cents;
}
export function pageText(html: string): string {
  const $ = load(html); $("script,style").remove(); return $.text().replace(/\s+/g, " ").trim();
}
export function amountAfter(text: string, label: RegExp): number {
  const found = label.exec(text);
  if (!found) throw new Error(`Official total not found: ${label.source}`);
  const tail = text.slice(found.index + found[0].length);
  const value = /^\s*[:|$*\s]*([\d,]+(?:\.\d{1,2})?)(?!\d)/.exec(tail);
  if (!value) throw new Error("Official total has no readable amount");
  return moneyCents(value[1]);
}
