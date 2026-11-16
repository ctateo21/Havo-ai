import { useId } from "react";
import { permitKinds, windAnswersSchema, type WindAnswers, type WindResult, type PermitEvidence } from "../../../../shared/wind-mitigation";

export type WindEvidenceFormProps = {
  value: WindAnswers;
  onChange: (value: WindAnswers) => void;
  result?: WindResult;
  permits?: PermitEvidence[];
  onRoofYear?: (year: number) => void;
};

// Form drafts deliberately allow incomplete values. Only the parent validates
// the complete WindAnswers payload when starting a quote.
type ReportDraft = Omit<NonNullable<WindAnswers["report"]>, "transcribedFromReport" | "shape"> & {
  transcribedFromReport: boolean;
  shape: NonNullable<WindAnswers["report"]>["shape"] | "";
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

export function WindEvidenceForm({ value, onChange, result, permits = [], onRoofYear }: WindEvidenceFormProps) {
  const id = useId();
  const report: ReportDraft = { ...emptyReport, ...value.report };
  const update = (patch: Partial<WindAnswers>) => onChange({ ...value, ...patch });
  const updateReport = (patch: Partial<ReportDraft>) => {
    // Do not parse here: an unchecked attestation, blank date, or missing
    // selection must survive in parent form state rather than being discarded.
    update({ report: { ...report, ...patch } as WindAnswers["report"] });
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
      case "transcribedFromReport": return "Check this only after copying the values from the existing report.";
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
      <p className="text-xs leading-relaxed text-muted-foreground">No upload needed. Copy the codes exactly; use Unknown where offered if the report does not say. These are user-transcribed entries, not a professional verification or a guarantee of carrier acceptance.</p>
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
        {select("report-roofToWall", "Report: roof-to-wall attachment", report.roofToWall,
          ["Unknown", "Toe Nails", "Clips", "Single Wraps", "Double Wraps"], next => updateReport({ roofToWall: next as ReportDraft["roofToWall"] }), errorFor("roofToWall"))}
        {select("report-roofDeck", "Report: roof deck attachment", report.roofDeck,
          ["Unknown", "A", "B", "C"], next => updateReport({ roofDeck: next as ReportDraft["roofDeck"] }), errorFor("roofDeck"))}
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
          <span>I copied these values from the seller’s existing wind mitigation report.</span>
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
        ["all", "partial", "unsure"], next => update({ allOpenings: next as WindAnswers["allOpenings"] }), undefined,
        "all = every window, exterior door, slider and garage door. partial = only some. unsure = coverage is not established.")}
      {select("peelAndStick", "Peel-and-stick roof underlayment / secondary water resistance?", value.peelAndStick,
        ["yes", "no", "unsure"], next => update({ peelAndStick: next as WindAnswers["peelAndStick"] }), undefined,
        "A roof replacement alone does not establish the underlayment used.")}
    </fieldset>

    {openingPermits.length > 0 && <div className="space-y-3 rounded-lg border border-primary/15 bg-primary/5 p-3">
      <h4 className="text-sm font-semibold">Opening permits: clues, not complete coverage</h4>
      <p className="text-xs leading-relaxed text-muted-foreground">A permit may cover only some openings. Confirm ALL windows, exterior doors, sliders and the garage door before selecting all. Nothing is selected automatically or confirmed by a permit.</p>
      {openingPermits.map((permit, index) => permitCard(permit, index, "opening"))}
      <button type="button" className={buttonClass} onClick={() => update({ allOpenings: "all",openingsConfirmed:false })}>Likely all protected — please confirm every opening</button>
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
