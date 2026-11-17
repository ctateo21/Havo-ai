import { useEffect, useId, useRef, useState } from "react";
import { authedFetch } from "@/lib/authed-fetch";
import { permitKinds, windAnswersSchema, type WindAnswers, type WindResult, type PermitEvidence } from "../../../../shared/wind-mitigation";

export type WindEvidenceFormProps = {
  value: WindAnswers;
  onChange: (value: WindAnswers) => void;
  result?: WindResult;
  permits?: PermitEvidence[];
  onRoofYear?: (year: number) => void;
  isAuthenticated?: boolean;
};

// Form drafts deliberately allow incomplete values. Only the parent validates
// the complete WindAnswers payload when starting a quote.
type ReportDraft = Omit<NonNullable<WindAnswers["report"]>, "transcribedFromReport" | "shape" | "roofDeck"> & {
  transcribedFromReport: boolean;
  shape: NonNullable<WindAnswers["report"]>["shape"] | "";
  roofDeck: "Unknown" | "A" | "B" | "C" | "D";
  uploadId?: string;
  inspector?: string;
  yearBuilt?: number;
  roofCovering?: string;
};
const emptyReport: ReportDraft = {
  reference: "", inspectionDate: "", transcribedFromReport: false,
  roofToWall: "Unknown", roofDeck: "Unknown", swr: "Unknown",
  opening: "Unknown", shape: "",
};
const inputClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelClass = "block text-xs font-semibold uppercase tracking-wide text-muted-foreground";
const buttonClass = "rounded-lg border border-primary/30 px-3 py-2 text-left text-xs font-medium text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30";
const fieldNames: Record<keyof WindResult["fields"], string> = {
  roofToWall: "Roof-to-wall attachment", roofDeck: "Roof deck attachment",
  swr: "Secondary water resistance", opening: "Opening protection", shape: "Roof shape",
};

function sourceLink(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed.href;
  } catch { /* Keep invalid URLs as plain source text. */ }
  return undefined;
}

export function WindEvidenceForm({ value, onChange, result, permits = [], onRoofYear, isAuthenticated = false }: WindEvidenceFormProps) {
  const id = useId();
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadError, setUploadError] = useState(false);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const latest = useRef({ value, onChange, isAuthenticated });
  latest.current = { value, onChange, isAuthenticated };
  const openingsTouched = useRef(false);
  const suggestedOpening = useRef(false);
  useEffect(() => () => {
    generation.current++;
    request.current?.abort();
  }, []);
  useEffect(() => {
    if (!isAuthenticated) {
      generation.current++;
      request.current?.abort();
      setUploading(false);
    }
  }, [isAuthenticated]);
  const hasOpeningPermit = permits.some(p => permitKinds(p).opening);
  useEffect(() => {
    if (!hasOpeningPermit || suggestedOpening.current) return;
    suggestedOpening.current = true;
    const current = latest.current;
    if (!openingsTouched.current && current.value.allOpenings === "unsure" && !current.value.openingsConfirmed) {
      current.onChange({ ...current.value, allOpenings: "all", openingsConfirmed: false });
    }
  }, [hasOpeningPermit]);
  async function upload(file: File) {
    const version = ++generation.current;
    request.current?.abort();
    setUploading(false);
    setUploadError(true);
    if (!latest.current.isAuthenticated) {
      setUploadMessage("Sign up or sign in to upload a private report. You can still enter report values manually.");
      return;
    }
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type) || file.size > 8 * 1024 * 1024 || file.size === 0) {
      setUploadMessage("Choose a non-empty PDF, JPEG or PNG no larger than 8 MiB.");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setUploading(true);
    setUploadError(false);
    setUploadMessage("Reading your report. Extracted values will need your review.");
    const body = new FormData();
    body.append("file", file);
    try {
      const response = await authedFetch("/api/insurance/wind-report", { method: "POST", body, signal: controller.signal });
      if (version !== generation.current) return;
      if (response.status === 401) throw new Error("Sign up or sign in to upload a private report. Manual entry is still available.");
      if (response.status === 413) throw new Error("This report is too large. Choose a file no larger than 8 MiB.");
      if (!response.ok) throw new Error("We couldn’t read that report. Try another file or enter its values manually.");
      const data = await response.json();
      if (version !== generation.current || !latest.current.isAuthenticated) return;
      if (typeof data.reportId !== "string" || !data.reportId.trim()) {
        throw new Error("The report could not be read. Try again or enter its values manually.");
      }
      const extracted = data.extracted && typeof data.extracted==="object" ? data.extracted : {};
      const choice = <T extends string,>(key: string, choices: readonly T[], fallback: T): T =>
        typeof extracted[key] === "string" && choices.includes(extracted[key] as T) ? extracted[key] as T : fallback;
      const draft: ReportDraft = {
        ...emptyReport, reference: data.reportId, uploadId: data.reportId, transcribedFromReport: false,
        inspectionDate: typeof extracted.inspectionDate === "string" ? extracted.inspectionDate : "",
        inspector: typeof extracted.inspector === "string" ? extracted.inspector : "",
        yearBuilt: typeof extracted.yearBuilt === "number" && Number.isInteger(extracted.yearBuilt) ? extracted.yearBuilt : undefined,
        roofCovering: typeof extracted.roofCovering === "string" ? extracted.roofCovering : "",
        roofToWall: choice("roofToWall", ["Unknown", "Toe Nails", "Clips", "Single Wraps", "Double Wraps"], "Unknown"),
        roofDeck: choice("roofDeck", ["Unknown", "A", "B", "C", "D"], "Unknown"),
        swr: choice("swr", ["Unknown", "Yes", "No"], "Unknown"),
        opening: choice("opening", ["Unknown", "A", "B", "C", "N", "X"], "Unknown"),
        shape: choice("shape", ["Hip", "Gable", "Flat"], ""),
      };
      latest.current.onChange({ ...latest.current.value, reportAvailable: true, report: draft as WindAnswers["report"] });
      setUploadMessage(data.extracted
        ? "Draft extracted. Review every field against the original report, fill any gaps, then check the confirmation below. No report credits are confirmed yet."
        : "Report saved privately. Analysis was unavailable; enter the values from your report and confirm them below.");
    } catch (error) {
      if (version !== generation.current) return;
      setUploadError(true);
      setUploadMessage(error instanceof Error ? error.message : "Upload failed. Please try again or enter values manually.");
    } finally {
      if (version === generation.current) setUploading(false);
    }
  }
  const report: ReportDraft = { ...emptyReport, ...value.report };
  const update = (patch: Partial<WindAnswers>) => onChange({ ...value, ...patch });
  const updateReport = (patch: Partial<ReportDraft>) => {
    // Do not parse here: an unchecked attestation, blank date, or missing
    // selection must survive in parent form state rather than being discarded.
    update({ report: { ...report, ...patch,
      ...(!("transcribedFromReport" in patch) ? { transcribedFromReport: false } : {}),
    } as WindAnswers["report"] });
  };
  const validation = windAnswersSchema.safeParse(value);
  const errorFor = (field: keyof ReportDraft) => {
    if (!value.reportAvailable || validation.success) return undefined;
    const invalid = validation.error.issues.some(issue => issue.path[0] === "report" && issue.path[1] === field);
    const missingReport = !value.report;
    if (!invalid && !missingReport) return undefined;
    switch (field) {
      case "reference": return "Enter a report reference between 3 and 120 characters.";
      case "inspectionDate": return "Enter a valid inspection date that is not in the future.";
      case "transcribedFromReport": return "Review the values against the existing report, then check the confirmation.";
      case "shape": return "Select the roof shape recorded in the report.";
      default: return missingReport ? undefined : "Choose a value listed on the report, or Unknown.";
    }
  };
  const select = (
    name: string, label: string, current: string, choices: readonly string[],
    change: (next: string) => void, error?: string, hint?: string,
  ) => <div className="space-y-1.5">
    <label className={labelClass} htmlFor={`${id}-${name}`}>{label}</label>
    <select id={`${id}-${name}`} className={inputClass} value={current} onChange={e => change(e.target.value)}
      aria-invalid={!!error} aria-describedby={error || hint ? `${id}-${name}-help` : undefined}>
      {current === "" && <option value="">Select the report value</option>}
      {choices.map(choice => <option value={choice} key={choice}>{choice}</option>)}
    </select>
    {(error || hint) && <p id={`${id}-${name}-help`} className={`text-xs leading-relaxed ${error ? "text-destructive" : "text-muted-foreground"}`}>{error || hint}</p>}
  </div>;
  const openingPermits = permits.filter(p => permitKinds(p).opening);
  const roofPermits = permits.filter(p => permitKinds(p).roof);
  const permitCard = (permit: PermitEvidence, index: number, kind: "roof" | "opening") => {
    const url = sourceLink(permit.sourceUrl);
    const year = /^\d{4}-/.test(permit.date) && Number.isFinite(Date.parse(permit.date)) ? Number(permit.date.slice(0, 4)) : undefined;
    return <div key={`${kind}-${permit.number}-${index}`} className="space-y-2 border-t border-border pt-3">
      <p className="break-words text-xs font-medium">Permit {permit.number} · {permit.date || "Date unavailable"}</p>
      <p className="break-words text-xs leading-relaxed text-muted-foreground">{permit.description}</p>
      <p className="break-words text-xs text-muted-foreground">Source: {url
        ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline">{permit.source || "Permit record"}</a>
        : permit.source || "Source unavailable"}</p>
      {kind === "roof" && onRoofYear && year !== undefined && year >= 2000 && year <= 2027 &&
        <button type="button" className={buttonClass} onClick={() => onRoofYear(year)}>Use {year} as estimated roof year</button>}
    </div>;
  };

  return <section className="space-y-5" aria-labelledby={`${id}-title`}>
    <div className="space-y-1">
      <h3 id={`${id}-title`} className="text-base font-semibold">Wind credits &amp; evidence</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">A credit is only as reliable as its source. Keep report entries separate from estimates and permit clues.</p>
    </div>
    <div className="space-y-2 rounded-lg border border-border p-4" aria-busy={uploading}>
      <label htmlFor={`${id}-upload`} className="block text-sm font-semibold">Upload an existing wind mitigation report</label>
      <p id={`${id}-upload-help`} className="text-xs leading-relaxed text-muted-foreground">
        PDF, JPEG or PNG · Up to 8 MiB. Uploading creates an editable draft, not verified credits. Manual entry is always available.
        {!isAuthenticated && " Sign up or sign in to upload a private report."}
      </p>
      <input id={`${id}-upload`} type="file" accept="application/pdf,image/jpeg,image/png"
        disabled={!isAuthenticated} aria-describedby={`${id}-upload-help`}
        className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-primary disabled:opacity-60`}
        onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void upload(file); }} />
      {uploadMessage && <p role={uploadError ? "alert" : "status"} className={`text-xs leading-relaxed ${uploadError ? "text-destructive" : "text-muted-foreground"}`}>{uploadMessage}</p>}
    </div>

    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-semibold">Do you have the seller’s existing wind mitigation report?</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-available`} value="yes" checked={value.reportAvailable === true}
          onChange={() => update({ reportAvailable: true, report: value.report ?? { ...emptyReport } as WindAnswers["report"] })} className="accent-primary" />Yes, I can enter its values</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-available`} value="no" checked={value.reportAvailable === false}
          onChange={() => update({ reportAvailable: false })} className="accent-primary" />No / not available</label>
      </div>
    </fieldset>

    {value.reportAvailable && <fieldset className="space-y-4 rounded-lg border border-border p-4">
      <legend className="px-1 text-sm font-semibold">Enter the actual report values</legend>
       <p className="text-xs leading-relaxed text-muted-foreground">Enter values manually or review the uploaded draft. Copy the codes exactly; use Unknown where offered if the report does not say. These are user-transcribed entries, not a professional verification or a guarantee of carrier acceptance.</p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-reference`} className={labelClass}>Report reference</label>
          <input id={`${id}-reference`} className={inputClass} value={report.reference}
            onChange={e => updateReport({ reference: e.target.value })} aria-invalid={!!errorFor("reference")} aria-describedby={`${id}-reference-help`} />
          <p id={`${id}-reference-help`} className={`text-xs ${errorFor("reference") ? "text-destructive" : "text-muted-foreground"}`}>{errorFor("reference") || "Report number or another identifying reference."}</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-inspectionDate`} className={labelClass}>Inspection date</label>
          <input type="date" id={`${id}-inspectionDate`} className={inputClass} value={report.inspectionDate}
            onChange={e => updateReport({ inspectionDate: e.target.value })} aria-invalid={!!errorFor("inspectionDate")} aria-describedby={errorFor("inspectionDate") ? `${id}-date-error` : undefined} />
          {errorFor("inspectionDate") && <p id={`${id}-date-error`} className="text-xs text-destructive">{errorFor("inspectionDate")}</p>}
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-inspector`} className={labelClass}>Report: inspector</label>
          <input id={`${id}-inspector`} className={inputClass} value={report.inspector ?? ""} onChange={e => updateReport({ inspector: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-yearBuilt`} className={labelClass}>Report: year built</label>
          <input id={`${id}-yearBuilt`} type="number" min={1800} max={new Date().getFullYear()} step={1} className={inputClass}
            value={report.yearBuilt ?? ""} onChange={e => updateReport({ yearBuilt: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-roofCovering`} className={labelClass}>Report: roof covering</label>
          <input id={`${id}-roofCovering`} className={inputClass} value={report.roofCovering ?? ""} onChange={e => updateReport({ roofCovering: e.target.value })} />
        </div>
        {select("report-roofToWall", "Report: roof-to-wall attachment", report.roofToWall,
          ["Unknown", "Toe Nails", "Clips", "Single Wraps", "Double Wraps"], next => updateReport({ roofToWall: next as ReportDraft["roofToWall"] }), errorFor("roofToWall"))}
        {select("report-roofDeck", "Report: roof deck attachment", report.roofDeck,
          ["Unknown", "A", "B", "C", "D"], next => updateReport({ roofDeck: next as ReportDraft["roofDeck"] }), errorFor("roofDeck"))}
        {select("report-swr", "Report: secondary water resistance", report.swr,
          ["Unknown", "Yes", "No"], next => updateReport({ swr: next as ReportDraft["swr"] }), errorFor("swr"))}
        {select("report-opening", "Report: opening protection code", report.opening,
          ["Unknown", "A", "B", "C", "N", "X"], next => updateReport({ opening: next as ReportDraft["opening"] }), errorFor("opening"))}
        {select("report-shape", "Report: roof shape", report.shape,
          ["Hip", "Gable", "Flat"], next => updateReport({ shape: next as ReportDraft["shape"] }), errorFor("shape"))}
      </div>
      <div className="space-y-1.5">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 accent-primary" checked={report.transcribedFromReport === true}
            onChange={e => updateReport({ transcribedFromReport: e.target.checked })}
            aria-invalid={!!errorFor("transcribedFromReport")} aria-describedby={`${id}-attestation-help`} />
          <span>I copied these values from, or reviewed them against, the seller’s existing wind mitigation report and confirm they match.</span>
        </label>
        <p id={`${id}-attestation-help`} className={`text-xs leading-relaxed ${errorFor("transcribedFromReport") ? "text-destructive" : "text-muted-foreground"}`}>
          {errorFor("transcribedFromReport") || "Your transcription is not independent or professional verification."}
        </p>
      </div>
    </fieldset>}

    <fieldset className="space-y-4">
      <legend className="mb-2 text-sm font-semibold">What you know about the property</legend>
      {value.reportAvailable && <p className="text-xs text-muted-foreground">These answers stay separate. A complete report takes priority for wind-credit calculations.</p>}
      {select("shape", "Roof shape", value.shape, ["Hip", "Gable", "Flat", "Not sure"],
        next => update({ shape: next as WindAnswers["shape"] }), undefined, "Not sure uses a gable estimate until confirmed.")}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={value.gated === true}
        onChange={e => update({ gated: e.target.checked })} /><span>Property is in a gated community</span></label>
      {select("allOpenings", "Are ALL openings impact-rated or protected by rated shutters?", value.allOpenings,
        ["all", "partial", "unsure"], next => { openingsTouched.current = true; update({ allOpenings: next as WindAnswers["allOpenings"], openingsConfirmed: false }); }, undefined,
        "all = every window, exterior door, slider and garage door. partial = only some. unsure = coverage is not established.")}
      {select("peelAndStick", "Peel-and-stick roof underlayment / secondary water resistance?", value.peelAndStick,
        ["yes", "no", "unsure"], next => update({ peelAndStick: next as WindAnswers["peelAndStick"] }), undefined,
        "A roof replacement alone does not establish the underlayment used.")}
    </fieldset>

    {openingPermits.length > 0 && <div className="space-y-3 rounded-lg border border-primary/15 bg-primary/5 p-3">
      <h4 className="text-sm font-semibold">Opening permits: clues, not complete coverage</h4>
      <p className="text-xs leading-relaxed text-muted-foreground">From county permit — please confirm. A newly found opening permit may preselect likely all protected if your answer is untouched and unsure. A permit may cover only some openings; it never confirms coverage or a credit.</p>
      {openingPermits.map((permit, index) => permitCard(permit, index, "opening"))}
      <button type="button" className={buttonClass} onClick={() => { openingsTouched.current = true; update({ allOpenings: "all",openingsConfirmed:false }); }}>Likely all protected — from county permit, please confirm</button>
      <p className="text-xs text-muted-foreground">This selects your answer only; it does not make the wind credit confirmed.</p>
    </div>}
    {roofPermits.length > 0 && <div className="space-y-3 rounded-lg border border-border p-3">
      <h4 className="text-sm font-semibold">Roof permit suggestions</h4>
      <p className="text-xs leading-relaxed text-muted-foreground">Permit year is not proof of installation year. Use a suggestion only if it matches this property’s roof replacement; it remains an estimate.</p>
      {roofPermits.map((permit, index) => permitCard(permit, index, "roof"))}
    </div>}

    {value.allOpenings==="all" && <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1 accent-primary" checked={value.openingsConfirmed===true}
        onChange={e=>update({openingsConfirmed:e.target.checked})}/>
      I confirm ALL windows, exterior doors, sliders and the garage door are impact-rated or protected by hurricane shutters.
    </label>}
    <div className="space-y-3 rounded-lg border border-border p-4" aria-labelledby={`${id}-evidence-title`}>
      <h4 id={`${id}-evidence-title`} className="text-sm font-semibold">Evidence behind the current calculation</h4>
      <p className="text-xs leading-relaxed text-muted-foreground">Confirmed describes the supplied source, not professional verification. Report values are transcribed by you; carrier review may still be required. Recalculate after changing answers to refresh these sources.</p>
      {result ? <>
        <dl className="divide-y divide-border">
          {(Object.keys(fieldNames) as (keyof WindResult["fields"])[]).map(key => {
            const evidence = result.fields[key];
            return <div key={key} className="space-y-1 py-3 first:pt-0 last:pb-0">
              <dt className="text-xs font-semibold">{fieldNames[key]}</dt>
              <dd className="flex flex-wrap items-center gap-2 text-sm">
                <span>{evidence.value}</span>
                <span className={`rounded border px-2 py-0.5 text-xs ${evidence.estimated ? "border-border bg-muted text-muted-foreground" : "border-primary/20 bg-primary/5 text-primary"}`}>
                  {evidence.estimated ? "Estimated" : result.haveReport ? "Confirmed · user-transcribed" : "Confirmed · user answer"}
                </span>
              </dd>
              <dd className="break-words text-xs leading-relaxed text-muted-foreground">Source: {evidence.source}</dd>
            </div>;
          })}
        </dl>
        {result.notes.length > 0 && <ul className="list-disc space-y-1 border-t border-border pl-4 pt-3 text-xs leading-relaxed text-muted-foreground">
          {result.notes.map((note, index) => <li key={index}>{note}</li>)}
        </ul>}
      </> : <div className="rounded-lg bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">No wind calculation yet. Your answers are saved in this form; each credit’s value, evidence status and source will appear after calculation. Permit clues alone do not confirm credits.</div>}
    </div>
  </section>;
}
