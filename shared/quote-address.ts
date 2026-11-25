/** Quote cache / saved-result address key: lowercased, single spaces,
 * punctuation stripped, capped at 200 chars. Shared so the dashboard can
 * match saved results to its rows with the server's exact rule. */
export function normalizeQuoteAddress(addr: string): string {
  return addr
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[,\.#]+/g, "")
    .slice(0, 200);
}
