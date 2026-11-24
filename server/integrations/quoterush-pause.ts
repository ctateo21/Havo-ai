import undici, { ProxyAgent } from "undici";

/** Operational safety switch, e.g. while reloading credentials in preview. */
export function quoteRushPaused() {
  return process.env.QUOTERUSH_PAUSED === "true";
}

type JsonRequestInit = Pick<RequestInit, "method" | "signal"> & {
  headers?: Record<string, string>;
  body?: string;
};

let cached: { url: string; agent: ProxyAgent } | undefined;
let loggedMode = false;

export function quoteRushFetch(url: string | URL, init?: JsonRequestInit) {
  if (quoteRushPaused()) throw new Error("QuoteRush calls are paused.");
  const proxyUrl = process.env.QUOTERUSH_PROXY_URL?.trim();
  if (!loggedMode) {
    console.info(`quoterush proxy: ${proxyUrl ? "enabled" : "disabled"}`);
    loggedMode = true;
  }
  if (cached && cached.url !== proxyUrl) {
    // Drain in-flight requests when credentials rotate or the proxy is disabled.
    void cached.agent.close().catch(() => {});
    cached = undefined;
  }
  if (!proxyUrl) return globalThis.fetch(url, init);

  if (!cached) {
    try {
      cached = { url: proxyUrl, agent: new ProxyAgent(proxyUrl) };
    } catch {
      // URL parsing errors can retain the credential-bearing input. Never chain them.
      throw new Error("Invalid QuoteRush proxy configuration.");
    }
  }
  return undici.fetch(url, { ...init, dispatcher: cached.agent }).catch(() => {
    // Never retry directly: that would silently switch the partner-facing IP.
    throw new Error("QuoteRush proxy request failed.");
  });
}
