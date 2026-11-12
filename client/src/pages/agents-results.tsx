import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Helmet } from "react-helmet";
import { RefreshCw, ShieldCheck, Inbox } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import { authedFetch } from "@/lib/authed-fetch";
import "./agents.css";

type Signup = {
  id: string; created_at: string; name: string; email: string; company: string; role: string;
  buyers_per_year: string; tier: string; utm_source: string; utm_medium: string; utm_campaign: string;
  email_status: string; fub_status: string; email_error: string | null; fub_error: string | null;
  unsubscribed_at: string | null;
};
type Results = {
  summary: { pageViews: number; tierClicks: number; submissions: number; signups: number; clickRate: number; tiers: { tier: string; clicks: number; signups: number }[]; sources: string[] };
  signups: Signup[];
};
const tierNames: Record<string, string> = { agent: "Agent", loan_officer: "Loan Officer", brokerage: "Brokerage" };
const roleNames: Record<string, string> = { realtor: "Realtor", loan_officer: "Loan Officer", broker_owner: "Broker or owner", insurance_agent: "Insurance agent" };
const buyerNames: Record<string, string> = { "1_10": "1 to 10", "11_25": "11 to 25", "26_plus": "26 or more" };
class AdminRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function getAdminResponse(path: string, init?: RequestInit) {
  const response = await authedFetch(path, { credentials: "include", ...init });
  if (response.status === 401) throw new AdminRequestError("Sign in to view experiment results.", 401);
  if (response.status === 403) throw new AdminRequestError("This page is restricted to administrators.", 403);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new AdminRequestError(body.error || "Results couldn't be loaded. Please try again.", response.status);
  return body;
}
function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

export default function AgentsResults() {
  const { user, isLoading: authLoading } = useAuth();
  const [source, setSource] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryError, setRetryError] = useState("");
  const [retryNotice, setRetryNotice] = useState("");
  const [accessDenied, setAccessDenied] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery<Results, AdminRequestError>({
    queryKey: ["agents-results", user?.id, source],
    enabled: !authLoading && !!user,
    retry: false,
    queryFn: ({ signal }) => getAdminResponse(`/api/admin/agents/results${source === null ? "" : `?utm_source=${encodeURIComponent(source)}`}`, { signal }),
  });
  const denied = accessDenied || query.error?.status === 401 || query.error?.status === 403;

  async function retryDelivery(id: string) {
    if (retrying) return;
    setRetrying(id); setRetryError(""); setRetryNotice("");
    try {
      await getAdminResponse(`/api/admin/agents/signups/${encodeURIComponent(id)}/retry`, { method: "POST" });
      setRetryNotice("Notification retry requested. Delivery states below reflect the latest results.");
      await queryClient.invalidateQueries({ queryKey: ["agents-results", user?.id] });
    } catch (cause) {
      if (cause instanceof AdminRequestError && [401, 403].includes(cause.status)) {
        setAccessDenied(true);
        queryClient.removeQueries({ queryKey: ["agents-results"] });
      }
      setRetryError(cause instanceof Error ? cause.message : "Retry failed. Please try again.");
    } finally { setRetrying(null); }
  }

  const data = query.data;
  const rate = data && data.summary.pageViews > 0 ? (data.summary.tierClicks / data.summary.pageViews) * 100 : 0;
  return (
    <div className="agents-admin">
      <Helmet><title>Agents experiment results | Havo</title><meta name="robots" content="noindex, nofollow" /></Helmet>
      <div className="agents-wrap">
        <div className="agents-admin-head">
          <div><p className="agents-eyebrow">Private · Demand test</p><h1 className="agents-section-title">Agents experiment</h1><p className="mt-3 text-sm text-muted-foreground">Interest, attribution, and notification delivery. Not subscriptions.</p></div>
          {user && !denied && <button className="agents-button" disabled={query.isFetching} onClick={() => { void query.refetch(); }}><RefreshCw size={15} aria-hidden="true" />{query.isFetching ? "Refreshing…" : "Refresh results"}</button>}
        </div>
        {authLoading || (user && query.isPending) ? <div aria-busy="true" aria-label="Loading results"><div className="agents-skeleton" /><div className="agents-skeleton" /><p className="mt-4 text-sm text-muted-foreground" role="status">Loading experiment results…</p></div>
          : !user || denied ? <section className="agents-message"><ShieldCheck size={28} className="mb-4 text-[#007f77]" aria-hidden="true" /><h2 className="font-bold text-lg">Administrator access required</h2><p className="mt-2">{!user ? "Sign in using the site header with an administrator account to view results." : query.error?.message || "Your account is not authorized to view these results. No results are displayed."}</p></section>
          : query.isError ? <section className="agents-message agents-error" role="alert"><h2 className="font-semibold">Results unavailable</h2><p className="mt-2 mb-4">{query.error.message}</p><button className="agents-button" onClick={() => { void query.refetch(); }}>Try again</button></section>
          : data ? <>
            <div className="flex flex-wrap items-end gap-4 mb-6">
              <label className="text-sm font-semibold">UTM source<select className="agents-field mt-2 min-w-52" value={source === null ? "__all" : `source:${source}`} onChange={event => { setSource(event.target.value === "__all" ? null : event.target.value.slice(7)); setRetryNotice(""); setRetryError(""); }}><option value="__all">All sources</option><option value="source:">Direct / no source</option>{Array.from(new Set([...data.summary.sources, ...(source ? [source] : [])])).filter(Boolean).map(item => <option key={item} value={`source:${item}`}>{item}</option>)}</select></label>
              <p className="text-xs text-muted-foreground pb-3">Exact source match. Direct means an empty source.</p>
            </div>
            <dl className="agents-metrics">
              {[["Page views", data.summary.pageViews.toLocaleString()], ["Tier clicks", data.summary.tierClicks.toLocaleString()], ["Signups", data.summary.signups.toLocaleString()], ["Click rate", `${rate.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`]].map(([label, value]) => <div className="agents-metric" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
            <p className="text-xs text-muted-foreground mt-4">Click rate = tier clicks ÷ page views. Repeat clicks count and can take the rate above 100%. Submissions received: {data.summary.submissions.toLocaleString()}.</p>
            <section className="agents-admin-section"><h2>Interest by tier</h2><div className="agents-table-wrap"><table className="agents-table"><thead><tr><th scope="col">Tier</th><th scope="col">Clicks</th><th scope="col">Signups</th></tr></thead><tbody>{["agent", "loan_officer", "brokerage"].map(tier => { const row = data.summary.tiers.find(item => item.tier === tier); return <tr key={tier}><td className="font-semibold">{tierNames[tier]}</td><td>{row?.clicks ?? 0}</td><td>{row?.signups ?? 0}</td></tr>; })}</tbody></table></div></section>
            <section className="agents-admin-section">
              <h2>Recent interest</h2>
              <p className="text-xs text-muted-foreground mb-5">Retries are offered only for failed or pending notifications. Sending states are never retried automatically.</p>
              {retryError && <p className="agents-message agents-error mb-4" role="alert">{retryError}</p>}
              {retryNotice && <p className="agents-message mb-4" role="status">{retryNotice}</p>}
              {data.signups.length === 0 ? <div className="agents-message py-10"><Inbox size={30} className="text-[#007f77] mb-4" aria-hidden="true" /><h3 className="font-bold">No interest submissions yet</h3><p className="mt-2">{source === null ? "New registrations will appear here when someone joins the list." : "No registrations match this source. Choose All sources to see the full experiment."}</p></div>
                : <div className="agents-table-wrap"><table className="agents-table"><thead><tr><th scope="col">Person / company</th><th scope="col">Interest</th><th scope="col">Attribution</th><th scope="col">Delivery</th><th scope="col">Received / actions</th></tr></thead><tbody>{data.signups.map(signup => <tr key={signup.id}>
                  <td><strong>{signup.name}</strong><a className="block underline mt-1" href={`mailto:${signup.email}`}>{signup.email}</a><small>{signup.company}</small><small>{roleNames[signup.role] || signup.role}</small></td>
                  <td>{tierNames[signup.tier] || signup.tier}<small>{buyerNames[signup.buyers_per_year] || signup.buyers_per_year} buyers / year</small></td>
                  <td className="max-w-52 break-words">{signup.utm_source || "Direct"}<small>Medium: {signup.utm_medium || "—"}</small><small>Campaign: {signup.utm_campaign || "—"}</small></td>
                  <td className="min-w-44 max-w-72"><div>Email: <span className="agents-state" data-state={signup.email_status}>{signup.email_status || "Unknown"}</span></div>{signup.email_error && <small className="break-words">{signup.email_error}</small>}<div className="mt-2">FUB: <span className="agents-state" data-state={signup.fub_status}>{signup.fub_status || "Unknown"}</span></div>{signup.fub_error && <small className="break-words">{signup.fub_error}</small>}{signup.unsubscribed_at && <small>Unsubscribed: {displayDate(signup.unsubscribed_at)}</small>}</td>
                  <td className="min-w-44"><time dateTime={signup.created_at}>{displayDate(signup.created_at)}</time>{[signup.email_status, signup.fub_status].some(status => status === "failed" || status === "pending") && <button className="agents-button !text-xs !px-3 !py-2 mt-3" disabled={!!retrying} onClick={() => { void retryDelivery(signup.id); }}>{retrying === signup.id ? "Requesting…" : "Retry notifications"}</button>}</td>
                </tr>)}</tbody></table></div>}
            </section>
          </> : null}
      </div>
    </div>
  );
}
