import { load } from "cheerio";
import { CountySession, moneyCents, pageText, webForm } from "./county-tax-http";
import { interactTaxPage, scrapeTaxPage } from "./firecrawl-tax";
import type { CountySlug } from "./parcel-resolver";
export interface OfficialBill {
  adValoremCents: number;
  navCents: number;
  combinedCents: number;
  lines: { name: string; amount: number }[];
  url: string;
  fetchedAt: string;
  taxYear: number;
  snapshot: string;
}
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
function finalMoney(line: string): number {
  const values = [...line.matchAll(/\$\s*([\d,]+\.\d{2})/g)];
  if (!values.length) throw new Error("County bill total missing");
  return moneyCents(values.at(-1)![1]);
}
export function parseCountyBill(markdown: string, year: number): Omit<OfficialBill, "url" | "fetchedAt"> {
  if (!new RegExp(`\\b${year}\\s+(?:Annual\\s+)?(?:bill|tax)`, "i").test(markdown)) throw new Error(`Current ${year} annual bill not found`);
  const rows = markdown.split("\n");
  const av = rows.find(r => /\bTotal Ad Valorem Taxes\b/i.test(r));
  const nav = rows.find(r => /\bTotal Non[- ]Ad Valorem Assessments\b/i.test(r));
  const combined = rows.find(r => /Combined taxes and assessments/i.test(r));
  if (!av || !nav || !combined) throw new Error("County bill is missing an ad valorem, assessment, or gross total");
  const adValoremCents = finalMoney(av), navCents = finalMoney(nav), combinedCents = finalMoney(combined);
  if (adValoremCents + navCents !== combinedCents) throw new Error("County bill totals do not reconcile");
  const start = rows.findIndex(r => /^#+\s*Non[- ]Ad Valorem Assessments/i.test(r));
  const end = rows.indexOf(nav);
  if (start < 0 || end <= start) throw new Error("County bill assessment table missing");
  const lines = rows.slice(start + 1, end).filter(r => r.startsWith("|") && /\$\s*[\d,]+\.\d{2}/.test(r)).map(r => ({
    name: r.split("|")[1].trim(), amount: finalMoney(r) / 100,
  }));
  if (Math.round(lines.reduce((n,l) => n + l.amount, 0) * 100) !== navCents) throw new Error("Assessment line items do not reconcile");
  // Only retain the tax tables: no owner names, mailing details, or payment identifiers.
  const tableStart = rows.findIndex(r => /^#+\s*Ad Valorem Taxes/i.test(r));
  return { adValoremCents, navCents, combinedCents, lines, taxYear: year, snapshot: rows.slice(tableStart,end+1).join("\n").slice(0,12000) };
}
export function assertRealEstateAccount(url: string, county: string): void {
  const parsed = new URL(url);
  if (parsed.hostname !== "county-taxes.net") throw new Error("Unexpected collector host");
  const encoded = parsed.pathname.split("/property-tax/")[1]?.split("/")[0];
  if (!encoded || !Buffer.from(decodeURIComponent(encoded), "base64").toString().startsWith(`${county}:real_estate:`)) throw new Error("Collector account is not matching real estate");
}
export function browserOutput(response: any): any {
  const output = response?.data?.stdout ?? response?.stdout ?? response?.data?.output ?? response?.output;
  if (typeof output !== "string") throw new Error("Browser output missing");
  try { return JSON.parse(output.trim().split("\n").at(-1)!); }
  catch { throw new Error("Browser output could not be parsed"); }
}
async function taxSysBill(county: CountySlug, parcel: string, year: number, cachedUrl?: string): Promise<OfficialBill> {
  const slug = county === "hillsborough" ? county : `fl-${county}`;
  const query = county === "hillsborough" ? `A${parcel.replace(/^A/i, "").replace(/\D/g, "")}` : parcel;
  let account = await scrapeTaxPage(cachedUrl || `https://county-taxes.net/${slug}/property-tax?search_query=${encodeURIComponent(query)}`);
  let url = account.metadata.url;
  if (!url?.includes("/property-tax/")) {
    const result = await interactTaxPage(`https://county-taxes.net/${slug}/property-tax?search_query=${encodeURIComponent(query)}`, `
      const account = ${JSON.stringify(query)};
      const normalize = s => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const buttons = page.getByRole('button', {name:'View',exact:true});
      let selected = null;
      for (const button of await buttons.all()) {
        const card = button.locator('xpath=..');
        const text = await card.innerText();
        if (normalize(text).includes(normalize(account))) { selected = button; break; }
      }
      if (!selected) throw new Error('Matching real-estate account not found');
      await Promise.all([page.waitForURL('**/property-tax/*'), selected.click()]);
      console.log(JSON.stringify({url:page.url()}));
    `);
    url = browserOutput(result).url;
    assertRealEstateAccount(url, county);
    account = await scrapeTaxPage(url);
  }
  assertRealEstateAccount(url, county);
  if (!norm(account.markdown).includes(norm(query))) throw new Error("Collector account does not match the requested parcel");
  const match = new RegExp(`\\[${year}\\s+Annual bill\\]\\((https://county-taxes\\.net/[^)]+/bills/[^)#]+)(?:#[^)]*)?\\)`, "i").exec(account.markdown);
  const billUrl = cachedUrl?.includes("/bills/") ? cachedUrl : match?.[1];
  if (!billUrl) throw new Error(`Current ${year} annual bill not found`);
  assertRealEstateAccount(billUrl,county);
  const bill = cachedUrl === billUrl ? account : await scrapeTaxPage(billUrl);
  if (!norm(bill.markdown).includes(norm(query))) throw new Error("Annual bill parcel does not match");
  return { ...parseCountyBill(bill.markdown, year), url: billUrl, fetchedAt: new Date().toISOString() };
}
export function parseCollectorHtml(html: string, year: number): Omit<OfficialBill, "url" | "fetchedAt"> {
  const $ = load(html);
  const text = pageText(html);
  if (!text.includes(String(year))) throw new Error(`Current ${year} bill not found`);
  const tables = $("table").toArray();
  function sectionTotal(label: RegExp): number {
    const row = $("tr").toArray().find(el => label.test($(el).text()) && $(el).find("tr").length === 0);
    if (!row) throw new Error("Official collector total missing");
    return finalMoney($(row).text());
  }
  // Phenix tables label the sum row simply TOTAL. Scope it to its own section.
  function scoped(label: RegExp): { cents: number; lines: {name:string;amount:number}[] } {
    const table = tables.find(el => label.test($(el).text()) && $(el).find("table").length === 0);
    if (!table) throw new Error("Collector tax section missing");
    const rows = $(table).find("tr").toArray();
    const total = rows.find(el => /\bTOTAL\b/i.test($(el).text()));
    if (!total) throw new Error("Collector section total missing");
    const lines = rows.filter(el => el !== total && /\$\s*[\d,]+\.\d{2}/.test($(el).text())).map(el => ({name:$(el).find("td").first().text().trim(),amount:finalMoney($(el).text())/100}));
    return {cents:finalMoney($(total).text()),lines};
  }
  const av = scoped(/Ad Valorem/i), nav = scoped(/Non[- ]Ad Valorem/i);
  let combined: number;
  if (/COMBINED TAXES AND ASSESSMENTS/i.test(text)) combined = sectionTotal(/COMBINED TAXES AND ASSESSMENTS/i);
  else combined = av.cents + nav.cents; // Phenix publishes both component totals, not always a combined row.
  if (av.cents + nav.cents !== combined || Math.round(nav.lines.reduce((n,l)=>n+l.amount,0)*100)!==nav.cents) throw new Error("Collector totals do not reconcile");
  return {adValoremCents:av.cents,navCents:nav.cents,combinedCents:combined,lines:nav.lines,taxYear:year,snapshot:JSON.stringify({av:av.cents,nav:nav.cents,combined,lines:nav.lines})};
}
async function directBill(county: CountySlug, parcel: string, year: number): Promise<OfficialBill> {
  const session = new CountySession();
  let html: string, url: string;
  if (county === "manatee") {
    const root = "https://secure.taxcollector.com/ptaxweb/";
    const search = `${root}editPropertySearch2.action`;
    await session.request(`${search}?action=list`);
    html = await session.request(search,new URLSearchParams({action:"search",searchField:"accountNumber",searchValue:parcel,paidStatus:"",taxYear:""}));
    const $ = load(html);
    const href = $('a[href*="action=detail"]').filter((_,el)=>$(el).closest("tr").text().includes(String(year))).first().attr("href");
    if (!href) throw new Error("Current Manatee bill not found");
    url = new URL(href,root).href;
  } else {
    const root = `https://${county}.floridatax.us/`;
    const search = `${root}AccountSearch?s=pt`;
    html = await session.request(search);
    const form = webForm(html,{txtSearchCriteria:parcel});
    const $ = load(html);
    const control = $("[name]").filter((_,e)=>($(e).attr("name")||"").endsWith("$btnSearch")).first().attr("name") || "ctl00$MainContent$btnSearch";
    form.set("__EVENTTARGET",control);
    html = await session.request(search,form);
    const result = load(html);
    const links = result('a[href*="PropertyDetail?"]').toArray().map(el => new URL(result(el).attr("href")!, root))
      .filter(u => u.searchParams.get("y")===String(year));
    const unique = [...new Set(links.map(u=>u.href))];
    if (unique.length !== 1) throw new Error("Collector search did not identify exactly one current parcel");
    url = unique[0];
  }
  html = await session.request(url);
  if (!norm(pageText(html)).includes(norm(parcel))) throw new Error("Collector bill parcel does not match");
  return {...parseCollectorHtml(html,year),url,fetchedAt:new Date().toISOString()};
}
export function fetchOfficialBill(county: CountySlug, parcel: string, year: number, cachedUrl?: string): Promise<OfficialBill> {
  return ["pinellas","polk","manatee"].includes(county) ? directBill(county,parcel,year) : taxSysBill(county,parcel,year,cachedUrl);
}
