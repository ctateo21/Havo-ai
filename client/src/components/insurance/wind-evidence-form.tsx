import { useEffect, useId, useRef, useState } from "react";
import { authedFetch } from "@/lib/authed-fetch";
import { windAnswersSchema, type WindAnswers, type WindResult, type PermitEvidence } from "../../../../shared/wind-mitigation";

export type WindEvidenceFormProps = {
  value: WindAnswers;
  onChange: (value: WindAnswers) => void;
  result?: WindResult;
  permits?: PermitEvidence[];
  onRoofYear?: (year: number) => void;
  isAuthenticated?: boolean;
  onSwrSelection?: () => void;
  onRoofShapeSelection?: () => void;
  roofShapeSource?: string;
  swrSource?: string;
  assumedSwr?: boolean;
};
type ReportDraft = Omit<NonNullable<WindAnswers["report"]>, "transcribedFromReport" | "shape"> & {
  transcribedFromReport: boolean;
  shape: "Hip" | "Gable" | "Flat";
};
const emptyReport: ReportDraft = {
  reference: "", inspectionDate: "", transcribedFromReport: false,
  roofToWall: "Unknown", roofDeck: "Unknown", swr: "No", opening: "X", shape: "Gable",
};
const inputClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelClass = "block text-sm font-medium text-foreground";
const fieldNames: Record<keyof WindResult["fields"], string> = {
  roofToWall: "Roof-to-wall attachment", roofDeck: "Roof deck attachment",
  swr: "Secondary water resistance", opening: "Opening protection", shape: "Roof shape",
};
const displayValue = (value: string) => value === "Unknown" || value === "Not sure"
  ? "Unverified — no credit assumed" : value === "Gable" ? "Gable/Other" : value;
const displaySource = (source: string) => source.replace(/\bunknown\b/gi, "unverified");

export function WindEvidenceForm({ value, onChange, result, isAuthenticated = false, onSwrSelection, onRoofShapeSelection, roofShapeSource, swrSource, assumedSwr }: WindEvidenceFormProps) {
  const id = useId();
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadError, setUploadError] = useState(false);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const latest = useRef({ value, onChange, isAuthenticated });
  latest.current = { value, onChange, isAuthenticated };
  useEffect(() => () => { generation.current++; request.current?.abort(); }, []);
  useEffect(() => {
    if (!isAuthenticated) { generation.current++; request.current?.abort(); setUploading(false); }
  }, [isAuthenticated]);
  async function upload(file: File) {
    const version = ++generation.current;
    request.current?.abort();
    setUploading(false);
    setUploadError(true);
    if (!latest.current.isAuthenticated) {
      setUploadMessage("Sign up or sign in to upload a private report. You can still enter its values manually.");
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
      if (response.status === 413) throw new Error("Choose a file no larger than 8 MiB.");
      if (!response.ok) throw new Error("We couldn’t read that report. Try another file or enter its values manually.");
      const data = await response.json();
      if (version !== generation.current || !latest.current.isAuthenticated || !latest.current.value.reportAvailable) return;
      if (typeof data.reportId !== "string" || !data.reportId.trim()) throw new Error("The report could not be read. Try again or enter its values manually.");
      const extracted = data.extracted && typeof data.extracted === "object" ? data.extracted : {};
      const choice = <T extends string,>(key: string, choices: readonly T[], fallback: T): T =>
        typeof extracted[key] === "string" && choices.includes(extracted[key] as T) ? extracted[key] as T : fallback;
      const draft: ReportDraft = {
        ...emptyReport, reference: data.reportId, uploadId: data.reportId,
        inspectionDate: typeof extracted.inspectionDate === "string" ? extracted.inspectionDate : "",
        yearBuilt: typeof extracted.yearBuilt === "number" && Number.isInteger(extracted.yearBuilt) ? extracted.yearBuilt : undefined,
        roofCovering: typeof extracted.roofCovering === "string" ? extracted.roofCovering : "",
        roofToWall: choice("roofToWall", ["Unknown", "Toe Nails", "Clips", "Single Wraps", "Double Wraps"], "Unknown"),
        roofDeck: choice("roofDeck", ["Unknown", "A", "B", "C", "D"], "Unknown"),
        swr: choice("swr", ["Yes", "No"], "No"),
        opening: choice("opening", ["A", "B", "C", "N", "X"], "X"),
        shape: choice("shape", ["Hip", "Gable", "Flat"], "Gable"),
      };
      latest.current.onChange({ ...latest.current.value, reportAvailable: true, report: draft as WindAnswers["report"] });
      setUploadMessage(data.extracted ? "Draft extracted. Open Review report values, check every field against the original, and confirm they match. Credits are not verified." : "Report saved privately. Analysis was unavailable; open Review report values to enter and confirm its values.");
    } catch (error) {
      if (version !== generation.current) return;
      setUploadError(true);
      setUploadMessage(error instanceof Error ? error.message : "Upload failed. Please try again or enter values manually.");
    } finally {
      if (version === generation.current) setUploading(false);
    }
  }
  const report: ReportDraft = { ...emptyReport, ...value.report };
  const update = (patch: Partial<WindAnswers>) => onChange({ ...value, ...patch, gated: false });
  const updateReport = (patch: Partial<ReportDraft>) => update({
    report: { ...report, ...patch, ...(!("transcribedFromReport" in patch) ? { transcribedFromReport: false } : {}) } as WindAnswers["report"],
  });
  const validation = windAnswersSchema.safeParse(value);
  const select = (name: string, label: string, current: string, choices: [string, string][], change: (next: string) => void) =>
    <label className="block space-y-1.5" htmlFor={`${id}-${name}`}><span className={labelClass}>{label}</span>
      <select id={`${id}-${name}`} aria-label={label} className={inputClass} value={current} onChange={e => change(e.target.value)} data-testid={`select-wind-${name}`}>
        {choices.map(([key, text]) => <option value={key} key={key}>{text}</option>)}
      </select>
    </label>;
  const propertyAnswers = <>
    {select("shape", "Roof shape", value.shape === "Not sure" ? "Gable" : value.shape, [["Flat", "Flat"], ["Gable", "Gable/Other"], ["Hip", "Hip"]], next => { onRoofShapeSelection?.(); update({ shape: next as WindAnswers["shape"] }); })}
    {select("allOpenings", "Are all openings impact-rated or protected by shutters?", value.allOpenings === "all" ? "all" : "unsure",
      [["all", "Yes"], ["unsure", "No/Unsure"]], next => update({ allOpenings: next as WindAnswers["allOpenings"], openingsConfirmed: next === "all" }))}
    {select("peelAndStick", "Secondary water resistance (SWR)?", value.peelAndStick === "yes" || value.peelAndStick === "unsure" && assumedSwr ? "yes" : "no",
      [["yes", "Yes"], ["no", "No/Unsure"]], next => { onSwrSelection?.(); update({ peelAndStick: next as WindAnswers["peelAndStick"] }); })}
  </>;
  return <section className="space-y-5" aria-labelledby={`${id}-title`}>
    <fieldset className="space-y-3">
      <legend id={`${id}-title`} className="mb-2 text-sm font-semibold">Do you have an existing wind mitigation report?</legend>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-available`} value="yes" checked={value.reportAvailable === true}
          onChange={() => update({ reportAvailable: true, report: value.report ?? { ...emptyReport } as WindAnswers["report"] })} className="accent-primary" />Yes</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-available`} value="no" checked={value.reportAvailable === false}
          onChange={() => { generation.current++; request.current?.abort(); setUploading(false); setUploadMessage(""); update({ reportAvailable: false, report: undefined }); }} className="accent-primary" />No</label>
      </div>
    </fieldset>
    {value.reportAvailable && <>
      <div className="space-y-2 rounded-lg border border-border p-4" aria-busy={uploading}>
        <label htmlFor={`${id}-upload`} className="block text-sm font-semibold">Upload your wind mitigation report</label>
        <p id={`${id}-upload-help`} className="text-xs leading-relaxed text-muted-foreground">Private PDF, JPEG or PNG · Up to 8 MiB. Uploading creates an editable draft, not verified credits.{!isAuthenticated && " Sign up or sign in to upload; manual entry is available below."}</p>
        <input id={`${id}-upload`} type="file" accept="application/pdf,image/jpeg,image/png" disabled={!isAuthenticated || uploading} aria-describedby={`${id}-upload-help`}
          className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-primary disabled:opacity-60`}
          onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void upload(file); }} />
        {uploading && <div className="h-2 rounded bg-primary/10" aria-hidden="true" />}
        {uploadMessage && <p role={uploadError ? "alert" : "status"} className={`text-xs leading-relaxed ${uploadError ? "text-destructive" : "text-muted-foreground"}`}>{uploadMessage}</p>}
      </div>
      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer text-sm font-semibold">Review report values</summary>
        <div className="mt-4 space-y-4">
          <p className="text-xs leading-relaxed text-muted-foreground">Review extracted values or enter them from your report. Entries are user-transcribed, not professional verification or a guarantee of carrier acceptance.</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="space-y-1.5"><span className={labelClass}>Inspection date</span><input type="date" className={inputClass} value={report.inspectionDate} onChange={e => updateReport({ inspectionDate: e.target.value })} /></label>
            <label className="space-y-1.5"><span className={labelClass}>Report: year built</span><input type="number" min="1800" max="2027" className={inputClass} value={report.yearBuilt ?? ""} onChange={e => updateReport({ yearBuilt: e.target.value ? Number(e.target.value) : undefined })} /></label>
            <label className="space-y-1.5"><span className={labelClass}>Report: roof covering</span><input className={inputClass} value={report.roofCovering ?? ""} onChange={e => updateReport({ roofCovering: e.target.value })} /></label>
            {select("report-roofToWall", "Report: roof-to-wall attachment", report.roofToWall, ["Unknown", "Toe Nails", "Clips", "Single Wraps", "Double Wraps"].map(v => [v, displayValue(v)]), next => updateReport({ roofToWall: next as ReportDraft["roofToWall"] }))}
            {select("report-roofDeck", "Report: roof deck attachment", report.roofDeck, ["Unknown", "A", "B", "C", "D"].map(v => [v, displayValue(v)]), next => updateReport({ roofDeck: next as ReportDraft["roofDeck"] }))}
            {select("report-swr", "Report: secondary water resistance", report.swr === "Yes" ? "Yes" : "No", [["Yes", "Yes"], ["No", "No/Unsure"]], next => updateReport({ swr: next as ReportDraft["swr"] }))}
            {select("report-opening", "Report: opening protection code", report.opening === "Unknown" ? "X" : report.opening, ["A", "B", "C", "N", "X"].map(v => [v, v === "X" ? "X — no credit" : v]), next => updateReport({ opening: next as ReportDraft["opening"] }))}
            {select("report-shape", "Report: roof shape", report.shape, [["Flat", "Flat"], ["Gable", "Gable/Other"], ["Hip", "Hip"]], next => updateReport({ shape: next as ReportDraft["shape"] }))}
          </div>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={report.transcribedFromReport === true} onChange={e => updateReport({ transcribedFromReport: e.target.checked })} /><span>I reviewed these values against my existing wind mitigation report and confirm they match.</span></label>
          {!validation.success && <p className="text-xs text-muted-foreground">Complete the report values and confirm your review before requesting quotes.</p>}
        </div>
      </details>
      <div className="space-y-4">{propertyAnswers}</div>
    </>}
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-sm font-semibold">Assumptions we made</summary>
      <div className="mt-4 space-y-4">
        <p className="text-xs leading-relaxed text-muted-foreground">Without a reviewed report, wind credits are estimates that require carrier verification. Missing records never establish a credit. You can change the assumptions below.</p>
        {!value.reportAvailable && propertyAnswers}
        {result ? <dl className="divide-y divide-border">{(Object.keys(fieldNames) as (keyof WindResult["fields"])[]).map(key => {
          const evidence = result.fields[key];
          const assumedSource = !result.haveReport
            ? key === "shape" ? roofShapeSource : key === "swr" ? swrSource : key === "opening" && evidence.value === "X" ? "No complete opening protection established; no credit assumed" : undefined
            : undefined;
          return <div key={key} className="space-y-1 py-3"><dt className="text-xs font-semibold">{fieldNames[key]}</dt><dd className="text-sm">{displayValue(evidence.value)} · {evidence.estimated || assumedSource ? "Estimate — subject to verification" : result.haveReport ? "User-reviewed report" : "Your answer"}</dd><dd className="break-words text-xs leading-relaxed text-muted-foreground">Basis: {displaySource(assumedSource || evidence.source)}</dd></div>;
        })}</dl> : <p className="text-xs leading-relaxed text-muted-foreground">No reviewed report yet. Unverified construction details receive no confirmed credit. Your answers remain editable.</p>}
      </div>
    </details>
  </section>;
}
