import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Helmet } from "react-helmet";
import { useAuth } from "@/context/auth-context";
import { authedFetch } from "@/lib/authed-fetch";
import { safeTaxUrl } from "@/lib/quick-property-tax";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PropertyTaxExemptionControls } from "@/components/property-tax-exemption-controls";
import { withAdminTaxParamsDefaults } from "@/lib/admin-property-tax-params";

type Row = Record<string, unknown>;
type Rates = { districts: Row[]; params: Row[] | Row };
class TaxAdminError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function request(path: string, init: RequestInit = {}) {
  const response = await authedFetch(path, { ...init, credentials: "include" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new TaxAdminError(response.status === 401 ? "Sign in with an administrator account."
    : response.status === 403 ? "This page is restricted to administrators."
    : data.error || "Property tax rates could not be loaded or saved.", response.status);
  return data;
}
const endpoint = "/api/admin/property-tax-rates";
const field = "mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";
const emptyDistrict: Row = {county:"",tax_year:null,district_code:"",district_name:"",city_default:null,
  school_mills:null,non_school_mills:null,levies:[],source_name:"",source_url:""};
const emptyParams: Row = {county:"",tax_year:null,just_value_ratio:null,uses_greater_of_current_just:false,
  school_hx_exemption:null,non_school_additional_hx:null,cpi_indexed:false,rounding:"",
  estimator_url:"",verified:false,verified_case:"",notes:"",exemption_mode:"county_estimator",amendment3_2027:false};

function RowEditor({ row, kind, onSave, disabled }: { row: Row; kind: "district" | "params"; onSave: (kind: "district" | "params", row: Row) => Promise<void>; disabled: boolean }) {
  const original = kind === "params" ? withAdminTaxParamsDefaults(row) : row;
  const [text, setText] = useState(JSON.stringify(original, null, 2));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  let draft: Row = {};
  let validDraft = false;
  try {
    const parsed = JSON.parse(text);
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") { draft = parsed; validDraft = true; }
  } catch { /* Preserve invalid advanced JSON until corrected. */ }
  const title = String(row.district_name ?? row.district ?? row.county ?? row.county_slug ?? row.name ?? row.id ?? "Configuration");
  return <form className="border-t border-border py-5" onSubmit={event => {
    event.preventDefault(); setError(""); setNotice("");
    void (async () => {
      try {
        const value = JSON.parse(text);
        if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Enter a JSON object.");
        await onSave(kind, value); setNotice("Saved. Source and year retained.");
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Save failed. Your edits have been retained."); }
    })();
  }}>
    <h3 className="mb-2 text-sm font-semibold">{title}</h3>
    {kind === "params" && <PropertyTaxExemptionControls value={draft} disabled={disabled || !validDraft}
      onChange={patch => { setText(JSON.stringify({ ...draft, ...patch }, null, 2)); setNotice(""); }} />}
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {Object.entries(original).filter(([key, value]) => !["id","updated_at","created_at","updated_by","fetched_at"].includes(key) &&
        !(kind === "params" && ["exemption_mode","non_school_additional_hx","amendment3_2027"].includes(key)) &&
        (typeof value !== "object" || value === null)).map(([key, original]) => {
        const numeric = typeof original === "number" || /year|mills|ratio|exemption|additional_hx/i.test(key);
        if (typeof original === "boolean") return <label key={key} className="flex items-center gap-2 self-center py-2 text-xs font-medium">
          <input type="checkbox" checked={draft[key] === true} disabled={disabled || !validDraft} onChange={event => {
            setText(JSON.stringify({...draft,[key]:event.target.checked},null,2)); setNotice("");
          }} />{key.replace(/_/g," ")}
        </label>;
        return <label key={key} className="text-xs font-medium">{key.replace(/_/g, " ")}
          <input className={field} value={String(draft[key] ?? "")} disabled={disabled || !validDraft}
            type={numeric ? "number" : /_url$/.test(key) ? "url" : "text"} step={numeric ? "any" : undefined}
            onChange={event => {
              const next = event.target.value;
              setText(JSON.stringify({ ...draft, [key]: numeric ? next ? Number(next) : null : next }, null, 2)); setNotice("");
            }} />
        </label>;
      })}
    </div>
    <details className="mt-3"><summary className="cursor-pointer text-xs font-medium">Advanced record & levy breakdown</summary><label className="mt-3 block text-xs font-medium">Rate record · JSON
      <textarea className={`${field} min-h-40 font-mono text-xs`} value={text} disabled={disabled} spellCheck={false} onChange={event => { setText(event.target.value); setNotice(""); }} />
    </label></details>
    <p className="my-2 text-xs text-muted-foreground">Amounts, millage units, source URLs, and effective years must match the published source. No default rates are supplied.</p>
    <Button type="submit" size="sm" disabled={disabled || text === JSON.stringify(original, null, 2)}>Save {kind === "district" ? "district" : "parameters"}</Button>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    {notice && <p role="status" className="mt-2 text-xs text-primary">{notice}</p>}
  </form>;
}

export default function PropertyTaxRates() {
  const { user, isLoading } = useAuth();
  const [busy, setBusy] = useState(false);
  const [deniedFor, setDeniedFor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [year, setYear] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [parcels, setParcels] = useState<File | null>(null);
  const [rates, setRates] = useState<File | null>(null);
  const denied = !!user && deniedFor === user.id;
  const query = useQuery<Rates, TaxAdminError>({
    queryKey: ["property-tax-rates-admin", user?.id], enabled: !!user && !isLoading && !denied, retry: false,
    queryFn: async ({ signal }) => {
      const data = await request(endpoint, { signal });
      if (!Array.isArray(data.districts) || !data.params || typeof data.params !== "object") throw new TaxAdminError("Invalid rates response. No fallback data is shown.", 502);
      return data;
    },
  });
  const forbidden = denied || [401, 403].includes(query.error?.status ?? 0);
  async function write(path: string, method: string, body: unknown) {
    setBusy(true); setError(""); setNotice("");
    try {
      await request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      await query.refetch();
    } catch (cause) {
      if (cause instanceof TaxAdminError && [401, 403].includes(cause.status)) setDeniedFor(user?.id ?? null);
      const message = cause instanceof Error ? cause.message : "Save failed. Please retry.";
      setError(message); throw cause;
    } finally { setBusy(false); }
  }
  const params = query.data ? Array.isArray(query.data.params) ? query.data.params : [query.data.params] : [];
  return <div className="mx-auto min-h-[100dvh] max-w-6xl px-4 py-10 sm:px-6">
    <Helmet><title>Property tax rates | Havo</title><meta name="robots" content="noindex, nofollow" /></Helmet>
    <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-primary">Property tax administration</p>
    <h1 className="text-3xl font-bold tracking-tight">Property tax rates & sources</h1>
    <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">Maintain auditable district rates and annual parameters. These records support planning estimates; they do not turn an estimate into an official county bill.</p>
    {isLoading || (!!user && query.isPending && !forbidden) ? <div aria-busy="true" aria-label="Loading property tax rates" className="mt-7 space-y-4">{[1, 2, 3].map(value => <div key={value} className="h-24 animate-pulse rounded-xl bg-muted" />)}</div>
      : !user || forbidden ? <Card className="mt-7"><CardContent className="p-6"><h2 className="font-semibold">Administrator access required</h2><p className="mt-2 text-sm text-muted-foreground">{user ? "Your account is not authorized to manage tax rates." : "Sign in using the site header with an administrator account."} Access is checked by the server.</p></CardContent></Card>
      : query.isError ? <Card className="mt-7"><CardContent className="space-y-3 p-6"><p role="alert">{query.error.message}</p><Button variant="outline" onClick={() => void query.refetch()}>Retry loading rates</Button></CardContent></Card>
      : <>
        <Card className="mt-7"><CardHeader><CardTitle className="text-lg">Annual Collier CSV import</CardTitle><p className="text-xs text-muted-foreground">Upload both files for the same tax year. Parcels require FOLIO (or PARCELID / PARCEL_ID) and MILLAGEAREA. Rates require MILLAGEAREA, SCHOOL_MILLS, NON_SCHOOL_MILLS, and optional DISTRICT_NAME. Raw annual formats must be normalized to these headers first; unverified formats are not inferred.</p></CardHeader><CardContent>
          <form className="space-y-4" onSubmit={event => {
            event.preventDefault(); setError(""); setNotice("");
            void (async () => {
              if (!parcels || !rates || !Number.isInteger(Number(year)) || Number(year) < 2020 || Number(year) > 2100 || !safeTaxUrl(sourceUrl)?.startsWith("https:")) {
                setError("Provide both CSV files, a tax year from 2020–2100, and an HTTPS source URL."); return;
              }
              setBusy(true);
              try {
                const [parcelsCsv, ratesCsv] = await Promise.all([parcels.text(), rates.text()]);
                await write(`${endpoint}/collier-import`, "POST", { taxYear: Number(year), parcelsCsv, ratesCsv, sourceUrl });
                setNotice(`Import completed for tax year ${year}.`);
              } catch (cause) { setError(cause instanceof Error ? cause.message : "Import failed. Your files are retained."); }
              finally { setBusy(false); }
            })();
          }}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="text-xs font-medium">Tax year<input className={field} required type="number" min="2020" max="2100" value={year} onChange={event => setYear(event.target.value)} disabled={busy} /></label>
              <label className="text-xs font-medium">Published source URL<input className={field} required type="url" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} disabled={busy} /></label>
              <label className="text-xs font-medium">Parcels CSV<input className={field} required type="file" accept=".csv,text/csv" onChange={event => setParcels(event.target.files?.[0] ?? null)} disabled={busy} /></label>
              <label className="text-xs font-medium">Rates CSV<input className={field} required type="file" accept=".csv,text/csv" onChange={event => setRates(event.target.files?.[0] ?? null)} disabled={busy} /></label>
            </div>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Validate & import annual files"}</Button>
          </form>
        </CardContent></Card>
        <Card className="mt-6"><CardHeader><CardTitle className="text-lg">District rates</CardTitle></CardHeader><CardContent>
          {!query.data?.districts.length && <p className="mb-4 rounded-md bg-muted/40 p-4 text-sm">No district rates returned. Import the published CSVs or add a sourced record below.</p>}
          {query.data?.districts.map((row, index) => <RowEditor key={`district-${index}`} row={row} kind="district" disabled={busy} onSave={(kind, value) => write(endpoint, "PUT", { kind, row: value })} />)}
          <details className="border-t pt-4"><summary className="cursor-pointer text-sm font-medium">Add district record</summary><RowEditor row={emptyDistrict} kind="district" disabled={busy} onSave={(kind, row) => write(endpoint, "PUT", { kind, row })} /></details>
        </CardContent></Card>
        <Card className="mt-6"><CardHeader><CardTitle className="text-lg">Annual parameters</CardTitle></CardHeader><CardContent>
          {params.map((row, index) => <RowEditor key={`params-${index}`} row={row} kind="params" disabled={busy} onSave={(kind, value) => write(endpoint, "PUT", { kind, row: value })} />)}
          <details className="border-t pt-4" open={!params.length}><summary className="cursor-pointer text-sm font-medium">Add annual parameters</summary><RowEditor row={emptyParams} kind="params" disabled={busy} onSave={(kind, row) => write(endpoint, "PUT", { kind, row })} /></details>
        </CardContent></Card>
        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        {notice && <p role="status" className="mt-4 text-sm text-primary">{notice}</p>}
      </>}
  </div>;
}
