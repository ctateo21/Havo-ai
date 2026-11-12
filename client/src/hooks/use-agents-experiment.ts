import { useEffect, useRef, useState } from "react";

export type AgentTier = "agent" | "loan_officer" | "brokerage";
export type AgentInterest = {
  name: string; email: string; company: string;
  role: "realtor" | "loan_officer" | "broker_owner" | "insurance_agent";
  buyersPerYear: "1_10" | "11_25" | "26_plus";
  consent: boolean; website: string;
};

export async function publicAgentPost(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(result.error || "Unable to save right now. Please try again."), { status: response.status });
  }
  return result;
}

export function useAgentsExperiment() {
  const context = useRef<{ sessionId: string; utmSource: string; utmMedium: string; utmCampaign: string } | null>(null);
  if (!context.current) {
    const params = new URLSearchParams(window.location.search);
    context.current = {
      sessionId: crypto.randomUUID(),
      utmSource: (params.get("utm_source") || "").slice(0, 200),
      utmMedium: (params.get("utm_medium") || "").slice(0, 200),
      utmCampaign: (params.get("utm_campaign") || "").slice(0, 200),
    };
  }
  const viewed = useRef(false);
  const [trackingError, setTrackingError] = useState(false);
  async function track(eventType: "page_view" | "tier_click", tier: AgentTier | null) {
    const event = { ...context.current, id: crypto.randomUUID(), eventType, tier };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await publicAgentPost("/api/agents/events", event);
        return;
      } catch (error) {
        const status = (error as Error & { status?: number }).status;
        if (attempt === 1 || (status && status < 500)) {
          setTrackingError(true);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 450));
      }
    }
  }
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    void track("page_view", null);
  }, []);
  return { context: context.current, track, trackingError };
}
