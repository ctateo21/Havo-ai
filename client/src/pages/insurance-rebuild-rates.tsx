import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Helmet } from "react-helmet";
import { useAuth } from "@/context/auth-context";
import { authedFetch } from "@/lib/authed-fetch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type CountyRate = {
  county_slug: string; county_name: string; county_fips: string; supported: boolean;
  frame_cost_per_sqft: number | null; masonry_cost_per_sqft: number | null;
  source_note: string | null; updated_at: string | null;
};
class RateRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function rateRequest(path: string, init: RequestInit = {}) {
  const response = await authedFetch(path, { credentials: "include", ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new RateRequestError(
    response.status === 401 ? "Sign in with an administrator account."
      : response.status === 403 ? "This page is restricted to administrators."
        : data.error || "County rates could not be saved or loaded. Please retry.", response.status,
  );
  return data;
}
const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20";

function RateEditor({ rate, saved, denied }: { rate: CountyRate; saved: (value: CountyRate) => void; denied: () => void }) {
  const [frame, setFrame] = useState(rate.frame_cost_per_sqft == null ? "" : String(rate.frame_cost_per_sqft));
  const [masonry, setMasonry] = useState(rate.masonry_cost_per_sqft == null ? "" : String(rate.masonry_cost_per_sqft));
  const [note, setNote] = useState(rate.source_note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const parse = (text: string) => text.trim() === "" ? null : Number(text);
  const valid = (text: string) => text.trim() === "" || (Number.isFinite(Number(text)) && Number(text) > 0);
  const dirty = frame !== (rate.frame_cost_per_sqft == null ? "" : String(rate.frame_cost_per_sqft)) ||
    masonry !== (rate.masonry_cost_per_sqft == null ? "" : String(rate.masonry_cost_per_sqft)) || note !== (rate.source_note ?? "");
  async function save() {
    setError(""); setNotice("");
    if (!valid(frame) || !valid(masonry)) { setError("Enter a positive cost per square foot, or leave blank to remove the rate."); return; }
    setSaving(true);
    try {
      await rateRequest(`/api/admin/rebuild-cost-rates/${encodeURIComponent(rate.county_slug)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frame_cost_per_sqft: parse(frame), masonry_cost_per_sqft: parse(masonry), source_note: note }),
      });
      // Read the authoritative row, including its server timestamp; never invent a source or saved rate.
      const result = await rateRequest("/api/admin/rebuild-cost-rates");
      const updated = result.rates?.find((item: CountyRate) => item.county_slug === rate.county_slug);
      if (!updated) throw new Error("Save could not be confirmed. Refresh before editing this county again.");
      setFrame(updated.frame_cost_per_sqft == null ? "" : String(updated.frame_cost_per_sqft));
      setMasonry(updated.masonry_cost_per_sqft == null ? "" : String(updated.masonry_cost_per_sqft));
      setNote(updated.source_note ?? "");
      saved(updated);
      setNotice("Saved.");
    } catch (cause) {
      if (cause instanceof RateRequestError && [401, 403].includes(cause.status)) denied();
      setError(cause instanceof Error ? cause.message : "Save failed. Your edits have been retained; retry.");
    } finally { setSaving(false); }
  }
  return <form className="border-t border-border py-5" onSubmit={e => { e.preventDefault(); void save(); }}>
    <div className="mb-3 flex flex-wrap items-center gap-2"><h2 className="font-semibold">{rate.county_name}</h2><span className={`rounded-full px-2 py-0.5 text-xs ${rate.supported ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>{rate.supported ? "Supported county" : "Not supported"}</span><span className="text-xs text-muted-foreground">FIPS {rate.county_fips}</span></div>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_2fr_auto] md:items-end">
      <label className="space-y-1 text-xs font-medium">Frame · $ / sq. ft.<input aria-label={`${rate.county_name} frame cost per square foot`} className={field} type="number" min="0" step="any" value={frame} disabled={saving} onChange={e => { setFrame(e.target.value); setNotice(""); }} placeholder="Not configured" /></label>
      <label className="space-y-1 text-xs font-medium">Masonry · $ / sq. ft.<input aria-label={`${rate.county_name} masonry cost per square foot`} className={field} type="number" min="0" step="any" value={masonry} disabled={saving} onChange={e => { setMasonry(e.target.value); setNotice(""); }} placeholder="Not configured" /></label>
      <label className="space-y-1 text-xs font-medium">Source note<input aria-label={`${rate.county_name} source note`} className={field} value={note} disabled={saving} onChange={e => { setNote(e.target.value); setNotice(""); }} placeholder="Source, methodology, and effective date" /></label>
      <Button type="submit" disabled={saving || !dirty}>{saving ? "Saving…" : "Save"}</Button>
    </div>
    <p className="mt-2 text-xs text-muted-foreground">Updated {rate.updated_at ? new Date(rate.updated_at).toLocaleString() : "date unavailable"}</p>
    {error && <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>}
    {notice && <p className="mt-2 text-xs text-primary" role="status">{notice}</p>}
  </form>;
}

export default function InsuranceRebuildRates() {
  const { user, isLoading } = useAuth();
  const client = useQueryClient();
  const [accessDeniedFor, setAccessDeniedFor] = useState<string | null>(null);
  const accessDenied = !!user && accessDeniedFor === user.id;
  const key = ["insurance-rebuild-cost-rates", user?.id];
  const query = useQuery<{ rates: CountyRate[] }, RateRequestError>({
    queryKey: key, enabled: !!user && !isLoading && !accessDenied, retry: false,
    queryFn: async ({ signal }) => {
      const result = await rateRequest("/api/admin/rebuild-cost-rates", { signal });
      if (!Array.isArray(result.rates)) throw new RateRequestError("Invalid county rate response. No fallback rates are shown.", 502);
      return result;
    },
  });
  const denied = accessDenied || query.error?.status === 401 || query.error?.status === 403;
  const rates = [...(query.data?.rates ?? [])].sort((a, b) => Number(b.supported) - Number(a.supported) || a.county_name.localeCompare(b.county_name));
  return <div className="mx-auto min-h-[100dvh] max-w-6xl px-4 py-10 sm:px-6">
    <Helmet><title>County rebuild cost rates | Havo</title><meta name="robots" content="noindex, nofollow" /></Helmet>
    <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-primary">Insurance administration</p>
    <h1 className="text-3xl font-bold tracking-tight">County rebuild cost rates</h1>
    <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">Coverage A uses confirmed living area, construction, and a configured county rate — not market value. Blank rates mean no automatic estimate. Concrete block and mixed construction use masonry; frame uses frame.</p>
    <Card className="mt-7"><CardHeader><CardTitle className="text-lg">Florida · all 67 counties</CardTitle><p className="text-xs text-muted-foreground">The 9 supported counties appear first, then all remaining counties alphabetically. Leave a field blank to clear its rate. No silent fallback.</p></CardHeader><CardContent>
      {isLoading || (!!user && query.isPending && !denied) ? <div className="space-y-4" aria-label="Loading county rates" aria-busy="true">{[1, 2, 3, 4].map(n => <div key={n} className="h-24 animate-pulse rounded-lg bg-muted" />)}</div>
        : !user || denied ? <div className="rounded-lg border border-border bg-muted/40 p-6"><h2 className="font-semibold">Administrator access required</h2><p className="mt-2 text-sm text-muted-foreground">{user ? "Your account is not authorized to manage county rates." : "Sign in using the site header with an administrator account."} Access is verified by the server.</p></div>
          : query.isError ? <div role="alert"><p className="mb-3 text-sm text-destructive">{query.error.message}</p><Button variant="outline" onClick={() => void query.refetch()}>Retry loading rates</Button></div>
            : !rates.length ? <div className="rounded-lg bg-muted/40 p-6"><h2 className="font-semibold">No county rates returned</h2><p className="my-3 text-sm text-muted-foreground">Nothing has been substituted. Reload or ask an administrator to check the configuration.</p><Button variant="outline" onClick={() => void query.refetch()}>Reload counties</Button></div>
              : <>{rates.length !== 67 && <p role="alert" className="mb-3 text-xs text-destructive">The server returned {rates.length} of 67 counties. Missing counties have not been fabricated.</p>}{rates.map(rate => <RateEditor key={`${user?.id}:${rate.county_slug}`} rate={rate} saved={updated => client.setQueryData<{ rates: CountyRate[] }>(key, old => old ? { rates: old.rates.map(item => item.county_slug === updated.county_slug ? updated : item) } : old)} denied={() => { setAccessDeniedFor(user?.id ?? null); client.removeQueries({ queryKey: key }); }} />)}</>}
    </CardContent></Card>
    <div className="mt-5 rounded-lg border border-primary/15 bg-primary/5 p-4 text-sm leading-relaxed">A higher rebuild cost does not always mean a higher premium. Safer construction and verified mitigation can lower a carrier's risk and premium even when replacement costs are higher. Carriers determine final coverage and pricing.</div>
  </div>;
}
