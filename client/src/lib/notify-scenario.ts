import { getSession } from "@/lib/auth";
import { authedFetch } from "@/lib/authed-fetch";
import { getStoredReferralSource } from "@/components/referral-source-dialog";

// Fire-and-forget notification to the assigned FollowUpBoss agent when a
// logged-in user saves a new scenario on a dashboard tool page. Mirrors the
// same fetch pattern used in estimate.tsx for Purchase scenarios. Never
// blocks or throws — failures are swallowed with .catch().
export function notifyNewScenario(scenarioType: string, address: string, details?: string): void {
  const addr = (address || "").trim();
  if (!addr) return;
  const sessionUser = getSession();
  if (!sessionUser) return;

  const fullName = (sessionUser.name || "").trim();
  const spaceIdx = fullName.indexOf(" ");
  const firstName = spaceIdx > 0
    ? fullName.slice(0, spaceIdx)
    : (fullName || sessionUser.email.split("@")[0]);
  const lastName = spaceIdx > 0 ? fullName.slice(spaceIdx + 1) : "-";

  authedFetch("/api/leads/notify-new-scenario", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstName,
      lastName,
      email: sessionUser.email,
      phone: sessionUser.phone || "",
      agent: sessionUser.agent || "Team",
      address: addr,
      scenarioType,
      scenarioDetails: details,
      referral: getStoredReferralSource() ?? undefined,
    }),
  }).catch(err => console.warn("Failed to notify agent of new scenario:", err));
}
