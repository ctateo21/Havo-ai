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
  roofMaterial?: string;
  onRoofMaterialChange?: (value: string) => void;
};
type ReportDraft = Omit<NonNullable<WindAnswers["report"]>, "transcribedFromReport" | "shape"> & {
  transcribedFromReport: boolean;
  shape: "Hip" | "Gable" | "Flat";
};
type ReportAssumedField = "roofToWall" | "roofDeck" | "swr" | "opening" | "shape" | "roofCovering" | "productApproval";
const reportField = (key: string): ReportAssumedField => (key === "material" ? "roofCovering" : key) as ReportAssumedField;
const emptyReport: ReportDraft = {
  reference: "", inspectionDate: "", transcribedFromReport: false,
  roofToWall: "Unknown", roofDeck: "Unknown", swr: "No", opening: "Unknown", shape: "Gable",
};
const inputClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelClass = "block text-sm font-medium text-foreground";
const materials: [string, string][] = [
  ["Architectural Shingles", "Shingle"], ["Tile", "Tile"], ["Metal", "Metal"],
  ["Tar and Gravel", "Built Up"], ["Rubber", "Membrane"], ["Rolled Roofing", "Rolled Roofing"],
];
const productApprovals: [string, string][] = ["Meets FBC 2001", "Meets FBC 1994", "Non-FBC"].map(v => [v, v]);
const decks: [string, string][] = [["A", "Level A"], ["B", "Level B"], ["C", "Level C"], ["Concrete", "Reinforced Concrete Roof Deck"]];
const attachments: [string, string][] = ["Toe Nails", "Clips", "Single Wraps", "Double Wraps", "Structural", "N/A"].map(v => [v, v === "N/A" ? "Other" : v]);
function reportMaterial(material?: string) {
  if (!material) return undefined;
  if (/shingl/i.test(material)) return "Architectural Shingles";
  if (/tile/i.test(material)) return "Tile";
  if (/metal/i.test(material)) return "Metal";
  if (/built.?up|tar.*gravel/i.test(material)) return "Tar and Gravel";
  if (/membrane|rubber/i.test(material)) return "Rubber";
  if (/roll/i.test(material)) return "Rolled Roofing";
  return undefined;
}

export function WindEvidenceForm({ value, onChange, result, isAuthenticated = false, onSwrSelection, onRoofShapeSelection, roofShapeSource, swrSource, assumedSwr, roofMaterial = "Architectural Shingles", onRoofMaterialChange }: WindEvidenceFormProps) {
  const id = useId();
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadError, setUploadError] = useState(false);
  const [missingReportFields, setMissingReportFields] = useState<string[]>(() =>
    value.report?.assumedFields?.map(key => key === "roofCovering" ? "material" : key) ?? []);
  const [edited, setEdited] = useState<string[]>([]);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const latest = useRef({ value, onChange, isAuthenticated });
  latest.current = { value, onChange, isAuthenticated };
  const estimatedFields = useRef(result?.haveReport ? undefined : result?.fields);
  if (result && !result.haveReport) estimatedFields.current = result.fields;
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
        productApproval: choice("productApproval", ["Meets FBC 2001", "Meets FBC 1994", "Non-FBC"] as const, "Meets FBC 2001"),
        roofToWall: choice("roofToWall", ["Unknown", "Toe Nails", "Clips", "Single Wraps", "Double Wraps", "Structural", "N/A"], "Unknown"),
        roofDeck: choice("roofDeck", ["Unknown", "A", "B", "C", "Concrete"], "Unknown"),
        swr: choice("swr", ["Unknown", "Yes", "No"], "Unknown"),
        opening: choice("opening", ["A", "B", "C", "N", "X"], "Unknown"),
        shape: choice("shape", ["Hip", "Gable", "Flat"], "Gable"),
      };
      const missing = [
        ...(!reportMaterial(draft.roofCovering) ? ["material"] : []),
        ...(!productApprovals.some(([key]) => key === extracted.productApproval) ? ["productApproval"] : []),
        ...(!attachments.some(([key]) => key === extracted.roofToWall) ? ["roofToWall"] : []),
        ...(!decks.some(([key]) => key === extracted.roofDeck) ? ["roofDeck"] : []),
        ...(!["Yes", "No"].includes(extracted.swr) ? ["swr"] : []),
        ...(!["A", "B", "C", "N", "X"].includes(extracted.opening) ? ["opening"] : []),
        ...(!["Hip", "Flat", "Gable"].includes(extracted.shape) ? ["shape"] : []),
      ];
      // Keep absent values absent; a visible planning default is not report evidence.
      if (missing.includes("productApproval")) delete draft.productApproval;
      if (missing.includes("shape")) delete (draft as Partial<ReportDraft>).shape;
      draft.assumedFields = missing.map(reportField);
      setMissingReportFields(missing);
      setEdited([]);
      latest.current.onChange({ ...latest.current.value, reportAvailable: true, report: draft as WindAnswers["report"] });
      const material = reportMaterial(draft.roofCovering);
      if (material) onRoofMaterialChange?.(material);
      setUploadMessage(data.extracted ? "Draft extracted. Review the list below against your original. Missing fields remain labeled assumptions; credits are not verified." : "Report saved privately. Analysis was unavailable; review the assumptions below and enter the values from your report.");
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
  const hasReportValue = (key: string, current: unknown) => value.reportAvailable && !!value.report &&
    !missingReportFields.includes(key) && !value.report.assumedFields?.includes(reportField(key)) &&
    current !== undefined && current !== "" && current !== "Unknown";
  const basis = (key: string, reportValue?: unknown, source?: string) => {
    if (hasReportValue(key, reportValue)) return "From your report · user review required";
    if (edited.includes(key)) return "Your answer · subject to carrier verification";
    return `Assumption · ${source?.replace(/\bunknown\b/gi, "not established") || "planning estimate; please review"}`;
  };
  const changeField = (key: string, patch: Partial<WindAnswers>, reportPatch?: Partial<ReportDraft>) => {
    setEdited(previous => previous.includes(key) ? previous : [...previous, key]);
    setMissingReportFields(previous => previous.filter(field => field !== key));
    if (value.reportAvailable && reportPatch) {
      const assumedFields = Array.from(new Set([
        ...(report.assumedFields ?? []), ...missingReportFields.map(reportField),
      ])).filter(field => field !== reportField(key));
      onChange({ ...value, ...patch, gated: false, report: { ...report, ...reportPatch, assumedFields, transcribedFromReport: false } as unknown as WindAnswers["report"] });
    } else update(patch);
  };
  const select = (name: string, label: string, current: string, choices: [string, string][], change: (next: string) => void, source: string) =>
    <div role="row" className="grid gap-2 py-3 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:items-center">
      <div role="cell"><label htmlFor={`${id}-${name}`} className={labelClass}>{label}</label></div>
      <div role="cell"><select id={`${id}-${name}`} aria-label={label} aria-describedby={`${id}-${name}-basis`} className={inputClass} value={current} onChange={e => change(e.target.value)} data-testid={`select-wind-${name}`}>
        {choices.map(([key, text]) => <option value={key} key={key}>{text}</option>)}
      </select></div>
      <div role="cell" className="min-w-0 md:col-span-2"><p id={`${id}-${name}-basis`} title={source} className="truncate text-xs leading-relaxed text-muted-foreground">{source}</p></div>
    </div>;
  const activeReport = value.reportAvailable ? value.report : undefined;
  const evidenceValue = (key: "roofDeck" | "roofToWall", choices: [string, string][], fallback: string) => {
    const reportValue = choices.some(([option]) => option === activeReport?.[key]) ? activeReport?.[key] : undefined;
    const candidate = reportValue ?? value[key] ?? estimatedFields.current?.[key].value;
    return choices.some(([option]) => option === candidate) ? candidate as string : fallback;
  };
  const currentShape = activeReport?.shape ?? (value.shape === "Not sure" ? "Gable" : value.shape);
  const currentSwr = activeReport?.swr === "Yes" || activeReport?.swr === "No" ? activeReport.swr === "Yes" : value.peelAndStick === "yes" || value.peelAndStick === "unsure" && (assumedSwr ?? estimatedFields.current?.swr.value === "Yes");
  const currentOpening = activeReport?.opening && activeReport.opening !== "Unknown" ? activeReport.opening === "A" : value.allOpenings === "all";
  return <section className="space-y-5" aria-labelledby={`${id}-title`}>
    <fieldset className="space-y-3">
      <legend id={`${id}-title`} className="mb-2 text-sm font-semibold">Do you have an existing wind mitigation report?</legend>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-available`} value="yes" checked={value.reportAvailable === true}
          onChange={() => {
            const missing = ["material", "productApproval", "roofToWall", "roofDeck", "shape", "swr", "opening"];
            setMissingReportFields(value.report?.assumedFields?.map(key => key === "roofCovering" ? "material" : key) ?? missing);
            update({ reportAvailable: true, report: value.report ?? { ...emptyReport, shape: undefined, swr: "Unknown", assumedFields: missing.map(reportField) } as unknown as WindAnswers["report"] });
          }} className="accent-primary" />Yes</label>
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
    </>}
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <div className="mb-4">
        <h3 className="text-sm font-semibold">Roof &amp; wind details</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Editable estimates, in wind mitigation report order. Assumptions are not verified credits; carriers must review supporting evidence.</p>
      </div>
      <div role="table" aria-label="Roof and wind details" className="divide-y divide-border">
        {select("material", "Roof Covering", reportMaterial(activeReport?.roofCovering) ?? roofMaterial, materials, next => {
          onRoofMaterialChange?.(next); changeField("material", {}, { roofCovering: next });
        }, basis("material", reportMaterial(activeReport?.roofCovering)))}
        {select("productApproval", "Product Approval Listing", activeReport?.productApproval ?? value.roofCovering ?? "Meets FBC 2001", productApprovals, next => {
          changeField("productApproval", { roofCovering: next as WindAnswers["roofCovering"] }, { productApproval: next as ReportDraft["productApproval"] });
        }, basis("productApproval", activeReport?.productApproval))}
        {select("roofDeck", "Roof Deck Attachment", evidenceValue("roofDeck", decks, "A"), decks, next => {
          changeField("roofDeck", { roofDeck: next as WindAnswers["roofDeck"] }, { roofDeck: next as ReportDraft["roofDeck"] });
        }, basis("roofDeck", activeReport?.roofDeck, estimatedFields.current?.roofDeck.source))}
        {select("roofToWall", "Roof-to-Wall Attachment", evidenceValue("roofToWall", attachments, "Toe Nails"), attachments, next => {
          changeField("roofToWall", { roofToWall: next as WindAnswers["roofToWall"] }, { roofToWall: next as ReportDraft["roofToWall"] });
        }, basis("roofToWall", activeReport?.roofToWall, estimatedFields.current?.roofToWall.source))}
        {select("shape", "Roof Shape", currentShape, [["Hip", "Hip"], ["Flat", "Flat"], ["Gable", "Gable/Other"]], next => {
          onRoofShapeSelection?.(); changeField("shape", { shape: next as WindAnswers["shape"] }, { shape: next as ReportDraft["shape"] });
        }, basis("shape", activeReport?.shape, roofShapeSource || result?.fields.shape.source))}
        {select("peelAndStick", "Secondary Water Resistance (SWR)", currentSwr ? "yes" : "no", [["yes", "Yes"], ["no", "No/Unsure"]], next => {
          onSwrSelection?.(); changeField("swr", { peelAndStick: next as WindAnswers["peelAndStick"] }, { swr: next === "yes" ? "Yes" : "No" });
        }, basis("swr", activeReport?.swr, swrSource || result?.fields.swr.source))}
        {select("allOpenings", "All openings impact-rated or shuttered?", currentOpening ? "all" : "unsure", [["all", "Yes"], ["unsure", "No/Unsure"]], next => {
          changeField("opening", { allOpenings: next as WindAnswers["allOpenings"], openingsConfirmed: next === "all" }, { opening: next === "all" ? "A" : "Unknown" });
        }, basis("opening", activeReport?.opening, "complete opening protection has not been established"))}
      </div>
    </div>
    {value.reportAvailable && <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">Review this same list against your report. Missing values are assumptions, not extracted findings. Enter the matching values above; if you cannot review the report, select No to continue with estimates.</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1.5"><span className={labelClass}>Inspection date</span><input type="date" className={inputClass} value={report.inspectionDate} onChange={e => updateReport({ inspectionDate: e.target.value })} /></label>
        <label className="space-y-1.5"><span className={labelClass}>Report: year built</span><input type="number" min="1800" max="2027" className={inputClass} value={report.yearBuilt ?? ""} onChange={e => updateReport({ yearBuilt: e.target.value ? Number(e.target.value) : undefined })} /></label>
      </div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={report.transcribedFromReport === true} onChange={e => {
        if (!e.target.checked) { updateReport({ transcribedFromReport: false }); return; }
        // Commit exactly the displayed answers on review. Absent extraction stays
        // labeled as an assumption, never an invented "From your report" finding.
        updateReport({
          roofCovering: reportMaterial(activeReport?.roofCovering) ?? roofMaterial,
          productApproval: activeReport?.productApproval ?? value.roofCovering ?? "Meets FBC 2001",
          roofDeck: evidenceValue("roofDeck", decks, "A") as ReportDraft["roofDeck"],
          roofToWall: evidenceValue("roofToWall", attachments, "Toe Nails") as ReportDraft["roofToWall"],
          shape: currentShape,
          swr: currentSwr ? "Yes" : "No",
          opening: hasReportValue("opening", activeReport?.opening) ? activeReport!.opening : currentOpening ? "A" : "Unknown",
          assumedFields: Array.from(new Set([...(report.assumedFields ?? []), ...missingReportFields.map(reportField)])),
          transcribedFromReport: true,
        });
      }} /><span>I reviewed these values against my existing wind mitigation report and confirm the answers above. Labeled assumptions remain estimates, not extracted findings.</span></label>
      {!validation.success && <p className="text-xs text-muted-foreground">Complete the report values and confirm your review before requesting quotes.</p>}
    </div>}
  </section>;
}
