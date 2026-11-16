/** Operational safety switch, e.g. while reloading credentials in preview. */
export function quoteRushPaused() {
  return process.env.QUOTERUSH_PAUSED === "true";
}
export const quoteRushFetch: typeof globalThis.fetch = (...args) => {
  if (quoteRushPaused()) throw new Error("QuoteRush calls are paused.");
  return globalThis.fetch(...args);
};
