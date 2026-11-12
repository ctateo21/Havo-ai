/** One shared queue covers scrapes and complete browser sessions, including cleanup. */
let active = 0;
const waiters: (() => void)[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function limited<T>(work: () => Promise<T>): Promise<T> {
  const limit = Math.max(1, Math.min(5, Number(process.env.FIRECRAWL_MAX_CONCURRENCY) || 2));
  if (active >= limit) await new Promise<void>(resolve => waiters.push(resolve));
  else active++;
  try { return await work(); }
  finally { const next = waiters.shift(); if (next) next(); else active--; }
}
export async function firecrawlRequest(path: string, method: string, body?: unknown, timeout = 30_000): Promise<any> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY not set");
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await fetch(`https://api.firecrawl.dev/v2${path}`, {
        method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeout),
      });
    } catch { throw new Error("Firecrawl timeout or connection failure"); }
    if (response.status === 429) {
      if (!attempt) { await sleep(10_000); continue; }
      throw new Error("Firecrawl busy");
    }
    if (!response.ok) throw new Error(`Firecrawl request failed (${response.status})`);
    const data = await response.json();
    if (data.success === false) throw new Error("Firecrawl could not load the official page");
    return data;
  }
  throw new Error("Firecrawl busy");
}
async function scrape(url: string) {
  const result = await firecrawlRequest("/scrape", "POST", {
    url, formats: ["markdown", "links"], onlyMainContent: true, waitFor: 12000, maxAge: 0,
  });
  const status = result.data?.metadata?.statusCode;
  if (!result.success || !(status >= 200 && status < 300)) throw new Error("Official page was unavailable");
  return result.data as { markdown: string; links: string[]; metadata: { scrapeId: string; url: string; statusCode: number } };
}
export const scrapeTaxPage = (url: string) => limited(() => scrape(url));
export async function interactTaxPage(url: string, code: string): Promise<any> {
  return limited(async () => {
    const start = await scrape(url);
    const id = start.metadata.scrapeId;
    if (!id) throw new Error("Firecrawl did not provide a browser session");
    try {
      const result = await firecrawlRequest(`/scrape/${encodeURIComponent(id)}/interact`, "POST", { code, language: "node", timeout: 120 }, 120_000);
      return result;
    } finally {
      // Do not log page content, credentials, or provider bodies.
      await firecrawlRequest(`/scrape/${encodeURIComponent(id)}/interact`, "DELETE");
      console.info("[county-tax] Firecrawl browser session stopped");
    }
  });
}
let collierNext = 0;
let collierTail: Promise<unknown> = Promise.resolve();
/** Serializes Collier page visits: never circumvent the appraiser's ten-second limit. */
export function paceCollier<T>(work: () => Promise<T>): Promise<T> {
  const job = collierTail.then(async () => {
    await sleep(Math.max(0, collierNext - Date.now()));
    collierNext = Date.now() + 10_000;
    return work();
  });
  collierTail = job.catch(() => undefined);
  return job;
}
