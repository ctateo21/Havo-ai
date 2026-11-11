import { reserveAi, aiUsageStore, parseUsage, type Usage } from "./ai-usage";

export type OpenRouterContent = string | Array<
  | { type: "text"; text: string }
  | { type: "file"; file: { filename: string; file_data: string } }
>;

export interface AiCitation { url: string; title: string }

export async function completeWithOpenRouter(input: {
  system: string;
  content: OpenRouterContent;
  maxTokens: number;
  purpose: "document" | "market";
  pdf?: boolean;
  webSearch?: boolean;
}): Promise<{ text: string; citations: AiCitation[] }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OpenRouter API key is not configured.");
  const model = (
    (input.purpose === "document"
      ? process.env.OPENROUTER_DOCUMENT_MODEL
      : process.env.OPENROUTER_MARKET_MODEL) ||
    (input.purpose === "document" ? "anthropic/claude-haiku-4.5" : "anthropic/claude-opus-4.5")
  ).trim();
  // Keep borrower data with the existing model provider during this migration.
  // A change of model family requires a deliberate privacy/capability review.
  if (!/^anthropic\/claude-[a-z0-9.-]+$/.test(model)) {
    throw new Error("The configured OpenRouter model must be an approved Anthropic Claude model.");
  }
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 8192 ||
      Buffer.byteLength(JSON.stringify(input.content)) + Buffer.byteLength(input.system) > 15 * 1024 * 1024) {
    throw new Error("AI input exceeds the supported size or output-token limit. Use a smaller document.");
  }
  const plugins: Record<string, unknown>[] = [];
  if (input.pdf) plugins.push({ id: "file-parser", pdf: { engine: "native" } });
  if (input.webSearch) plugins.push({ id: "web", engine: "native", max_results: 5 });
  const reservation = await reserveAi(input.purpose);
  let usage: Usage | null = null;
  let success = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Title": "Havo",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        usage: { include: true },
        max_tokens: input.maxTokens,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.content },
        ],
        // No automatic model changes, third-party OCR, or silent direct-API fallback.
        provider: { only: ["anthropic"], allow_fallbacks: false, data_collection: "deny" },
        ...(plugins.length ? { plugins } : {}),
      }),
    });
    if (!response.ok) {
      // Provider bodies can echo document content or credentials; never expose them.
      const hint = response.status === 401 || response.status === 403
        ? "Check the server's OpenRouter credentials and provider permissions."
        : response.status === 402
          ? "Check available OpenRouter credits and the API key spending limit."
          : response.status === 429
            ? "The AI service is busy. Please try again shortly."
            : "Please try again later.";
      throw new Error(`OpenRouter request failed (${response.status}). ${hint}`);
    }
    let data: any;
    try { data = await response.json(); }
    catch { throw new Error("OpenRouter returned an invalid response."); }
    usage = parseUsage(data?.usage);
    if (data?.error) throw new Error("OpenRouter could not complete the analysis.");
    const choice = data?.choices?.[0];
    if (!choice || choice.finish_reason !== "stop") {
      throw new Error("OpenRouter did not return a complete analysis. Please try again.");
    }
    const text = choice.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("OpenRouter returned an empty analysis.");
    }
    const citations = new Map<string, AiCitation>();
    for (const annotation of choice.message.annotations ?? []) {
      if (annotation?.type !== "url_citation") continue;
      const c = annotation.url_citation;
      if (typeof c?.url !== "string") continue;
      try {
        const url = new URL(c.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") continue;
        citations.set(c.url, { url: c.url, title: typeof c.title === "string" ? c.title : c.url });
      } catch { /* Ignore malformed citation URLs. */ }
    }
    success = true;
    return { text: text.trim(), citations: [...citations.values()] };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("OpenRouter analysis timed out. Please try again.");
    if (error instanceof Error && error.message.startsWith("OpenRouter")) throw error;
    throw new Error("OpenRouter connection failed. Please try again.");
  } finally {
    clearTimeout(timeout);
    try { await aiUsageStore.finish(reservation, input.purpose, usage, success); }
    catch { console.warn("[ai-usage] Accounting finalization failed; admission remains counted."); }
  }
}
