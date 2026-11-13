import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Loader2, Search, MapPin, Home, AlertCircle, CheckCircle2, ExternalLink } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useQuoteAccess, type QuoteType } from "@/context/quote-access-context";
import { useToast } from "@/hooks/use-toast";

// Mirror of server-side PropertyScenario. Kept loose (optional fields) so a
// schema change on the server doesn't immediately break the UI.
export interface LookedUpProperty {
  source: "Zillow via Apify";
  address: string;
  zillowUrl: string;
  zestimate: number | null;
  listingPrice: number | null;
  purchasePrice: number | null;
  estimatedHomeValue: number | null;
  /** Monthly rent estimate. Never use as a purchase price. */
  rentZestimate: number | null;
  hoaMonthly: number | null;
  propertyType: string;
  yearBuilt: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFeet: number | null;
  lotSize: number | null;
  photos: string[];
  listingDescription: string;
  parsedInsuranceClues: Record<string, any>;
  insurancePolicyType: "HO3" | "HO6" | "DP3" | "";
  occupancyType: string;
  lastPulledAt: string;
  /** City as parsed from the original Google-formatted address (if available). */
  googleCity?: string;
  /** City as reported by Zillow for the matched property (if available). */
  zillowCity?: string;
  /** UI-preferred city — defaults to Google's, falls back to Zillow's. */
  displayCity?: string;
  /** True when street/ZIP/state matched but Google and Zillow disagree on city. */
  cityMismatch?: boolean;
  /** True when Zillow reports the home as sold. */
  isSold?: boolean;
  /** Last sold price reported by Zillow (only set when isSold). */
  soldPrice?: number | null;
  /** Last sold date (ISO string) reported by Zillow (only set when isSold). */
  soldDate?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialAddressOrUrl?: string;
  applyLabel?: string;        // text on the confirm button (e.g. "Use these values")
  onApply: (p: LookedUpProperty) => void;
}

function money(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function CluePill({ label, value }: { label: string; value: any }) {
  if (value === null || value === undefined || value === false) return null;
  const display = typeof value === "boolean" ? "Yes" : String(value);
  return (
    <Badge variant="secondary" className="text-xs">
      <CheckCircle2 className="h-3 w-3 mr-1 text-green-600" />
      {label}: {display}
    </Badge>
  );
}

export default function PropertyLookupDialog({
  open, onOpenChange, initialAddressOrUrl = "", applyLabel = "Apply to scenario", onApply,
}: Props) {
  const { toast } = useToast();
  const { authorize, requireAccount } = useQuoteAccess();
  const [input, setInput] = useState(initialAddressOrUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [property, setProperty] = useState<LookedUpProperty | null>(null);
  const [cached, setCached] = useState(false);

  // Reset when dialog reopens (and pick up the new initial address).
  useEffect(() => {
    if (open) {
      setInput(initialAddressOrUrl);
      setError(null);
      setProperty(null);
      setCached(false);
    }
  }, [open, initialAddressOrUrl]);

  async function runLookup() {
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    setProperty(null);
    try {
      const quoteType = ({
        "/estimate": "purchase", "/cash-buy": "cash", "/refinance": "refinance",
        "/insurance": "insurance", "/seller": "seller",
      } as Record<string, QuoteType>)[window.location.pathname];
      // Listing URLs cannot be bound to an address until resolved. Require a
      // real account rather than spending anonymous access on an opaque URL.
      if (/^https?:\/\//i.test(input.trim())) {
        if (!await requireAccount()) return;
      } else if (quoteType && !await authorize(quoteType, input.trim())) return;
      const res = await apiRequest("POST", "/api/zillow-property-lookup", { addressOrUrl: input.trim() });
      const body = await res.json();
      setProperty(body.property as LookedUpProperty);
      setCached(Boolean(body.cached));
    } catch (e: any) {
      // apiRequest throws "<status>: <body>" on non-2xx.
      const msg = String(e?.message ?? e);
      const friendly =
        /404/.test(msg) ? "We couldn't find that property on Zillow. Try a different format (e.g. include city + state)." :
        /504/.test(msg) ? "Zillow took too long to respond. Try again in a moment." :
        /400/.test(msg) ? "Please enter an address or Zillow URL." :
        "Lookup failed. Please try again.";
      setError(friendly);
    } finally {
      setLoading(false);
    }
  }

  function handleApply() {
    if (!property) return;
    onApply(property);
    toast({ title: "Property data applied", description: property.address || "Values updated." });
    onOpenChange(false);
  }

  const clues = property?.parsedInsuranceClues ?? {};

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Home className="h-5 w-5" /> Pull property data from Zillow
          </DialogTitle>
          <DialogDescription>
            Paste an address or a Zillow listing URL. We'll fetch the Zestimate, listing price, HOA, property type,
            year built, and scan the description for insurance-relevant features.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="123 Main St, Tampa, FL 33602 — or zillow.com/homedetails/..."
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); runLookup(); } }}
              disabled={loading}
              data-testid="property-lookup-input"
            />
            <Button onClick={runLookup} disabled={loading || !input.trim()} data-testid="property-lookup-search">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              <span className="ml-2 hidden sm:inline">{loading ? "Looking up…" : "Look up"}</span>
            </Button>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading && !property && (
            <div className="rounded-md border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
              Fetching from Zillow — this usually takes 15–45 seconds.
            </div>
          )}

          {property && (
            <div className="space-y-4 rounded-lg border bg-card p-4">
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <MapPin className="h-4 w-4 flex-shrink-0" />
                    <span className="truncate">{property.address || "Address unavailable"}</span>
                  </div>
                  {property.zillowUrl && (
                    <a
                      href={property.zillowUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      View on Zillow <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
                {cached && (
                  <Badge variant="outline" className="text-xs flex-shrink-0">Cached (≤24h)</Badge>
                )}
              </div>

              {/* Photo */}
              {property.photos[0] && (
                <img
                  src={property.photos[0]}
                  alt={property.address}
                  className="w-full h-48 object-cover rounded-md"
                  loading="lazy"
                />
              )}

              {/* Core values */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <Stat label="Zestimate" value={money(property.zestimate)} />
                <Stat label="Listing price" value={money(property.listingPrice)} />
                <Stat label="HOA / mo" value={money(property.hoaMonthly)} />
                <Stat label="Year built" value={property.yearBuilt?.toString() ?? "—"} />
                <Stat label="Type" value={property.propertyType || "—"} />
                <Stat label="Bed / Bath" value={`${property.bedrooms ?? "—"} / ${property.bathrooms ?? "—"}`} />
                <Stat label="Sq ft" value={property.squareFeet?.toLocaleString() ?? "—"} />
                <Stat label="Insurance form" value={property.insurancePolicyType || "—"} />
              </div>

              {/* Insurance clues — only if anything matched */}
              {(clues.rawMatchedPhrases?.length ?? 0) > 0 && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      Insurance clues from listing
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      <CluePill label="Roof year" value={clues.roofYear} />
                      <CluePill label="Roof" value={clues.roofConditionText} />
                      <CluePill label="Impact windows" value={clues.hasImpactWindows} />
                      <CluePill label="Impact doors" value={clues.hasImpactDoors} />
                      <CluePill label="Impact garage" value={clues.hasImpactGarageDoor} />
                      <CluePill label="Shutters" value={clues.hasHurricaneShutters} />
                      <CluePill label="Electrical updated" value={clues.updatedElectrical} />
                      <CluePill label="Plumbing updated" value={clues.updatedPlumbing} />
                      <CluePill label="HVAC updated" value={clues.updatedHVAC} />
                      <CluePill label="Flood zone mentioned" value={clues.floodZoneMentioned} />
                      <CluePill label="Wind mitigation mentioned" value={clues.windMitigationMentioned} />
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleApply} disabled={!property} data-testid="property-lookup-apply">
            {applyLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/40 p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</p>
      <p className="text-sm font-semibold mt-0.5 truncate">{value}</p>
    </div>
  );
}
