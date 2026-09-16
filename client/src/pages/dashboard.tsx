import { useState, useEffect, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import {
  Home, RefreshCw, Shield, Search, LogOut, Trash2, ExternalLink,
  MapPin, Calendar, Plus, X, Pencil, Check, Tag, Banknote,
  ArrowRight,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/context/auth-context";
import {
  getPurchaseScenarios, savePurchaseScenarios,
  getTrackedLoans, saveTrackedLoans, subscribeAuthChange,
  getInsuranceScenarios, saveInsuranceScenarios, getSession,
  type CashBuyOccupancyType,
  getSellerScenarios, saveSellerScenarios, subscribePersistenceError,
  getCashBuyScenarios, saveCashBuyScenarios,
  type CashBuyScenario,
  type InsuranceScenario, type PurchaseScenario,
  type SellerScenario, type SellerScenarioStatus,
  hasValidatedCashBuyPropertyTax, hasValidatedPurchasePropertyTax,
} from "@/lib/auth";
import {
  normalizePropertyKey,
  getOccupancyOverride,
  setOccupancyOverride,
  type OccupancyType,
} from "@/lib/property-key";
import {
  getDefaultInsurancePolicyType,
  resolveInsurancePropertyTypeForAddress,
  isCondoOrTownhomePropertyType,
} from "@/lib/insurance-policy-type";
import { calculateDefaultHomeownersInsurance } from "@/lib/insurance-default";
import {
  readDismissedInsuranceKeys,
  writeDismissedInsuranceKeys,
} from "@/lib/insurance-dismissals";
import {
  calcInsurancePremium,
  DEFAULT_INSURANCE_FACTORS,
  type InsuranceFactors,
} from "@/components/insurance/property-insurance-simulator";
import { fetchFloodZone } from "@/lib/flood-zone";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useGooglePlaces } from "@/hooks/use-google-places";
import { useToast } from "@/hooks/use-toast";
import {
  getBestOption, getBestConventionalRate, PROPERTY_TYPE_ADJUSTMENTS,
  HE_MAX_CLTV, HE_RATE_MARGIN, NEW_TERM_YEARS,
  CLOSING_COST_PERCENT, CLOSING_COST_FIXED,
  type TrackedLoan, type LiveRate, type BestOption,
} from "@/components/refi/loan-tracker";
import { calculateRefinance, calculateMonthlyPayment } from "@/lib/refi-calculations";
import { resolveTrackedLoanBalance } from "@/lib/tracked-loan-balance";
import { createOrUpdateSellerScenarioFromRefinance } from "@/lib/seller-from-refinance";
import { getEstimatedSellerTaxesDue } from "@/lib/seller-taxes";
import { calculateSellerNetProceeds, resolveSellerClosingCosts } from "@/lib/seller-net-proceeds";
import {
  ensureInsuranceForAddresses,
  type BulkAddress,
} from "@/lib/insurance-from-property";
import { AlertBell } from "@/components/dashboard/alert-bell";

interface LiveRatesResponse { rates: LiveRate[]; source: string; disclaimer: string; asOf: string; }

// Fallback "today's market" rate when live rates haven't loaded yet.
const FALLBACK_TODAY_RATE = 6.65;

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  primary: "Primary Home", secondary: "2nd Home", investment: "Investment",
};
const PROPERTY_TYPE_COLORS: Record<string, string> = {
  primary: "bg-background text-foreground border",
  secondary: "bg-amber-600 text-white border-amber-600",
  investment: "bg-red-600 text-white border-red-600",
};

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}


function RecStat({ label, value, valueClass }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div className="rounded-md border bg-background/80 p-2.5 min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold truncate">{label}</p>
      <p className={`text-sm font-bold truncate ${valueClass ?? ""}`}>{value}</p>
    </div>
  );
}

function HomeValueStat({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState(String(Math.round(value)));

  function commit() {
    const parsed = parseFloat(input.replace(/[^0-9.]/g, ""));
    if (!isNaN(parsed) && parsed > 0) onSave(parsed);
    setEditing(false);
  }

  return (
    <div className="rounded-md border bg-background/80 p-2.5 min-w-0" onClick={e => e.stopPropagation()}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold truncate">Est. Home Value</p>
      {editing ? (
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-xs font-medium">$</span>
          <input
            type="text"
            className="border rounded px-1.5 py-0.5 text-xs w-full min-w-0 bg-background"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            autoFocus
          />
          <button onClick={commit} className="text-green-600 hover:text-green-700 shrink-0" aria-label="Save"><Check className="h-3.5 w-3.5" /></button>
          <button onClick={() => setEditing(false)} className="text-muted-foreground hover:text-foreground shrink-0" aria-label="Cancel"><X className="h-3.5 w-3.5" /></button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold truncate">{formatCurrency(value)}</span>
          <button
            onClick={() => { setInput(String(Math.round(value))); setEditing(true); }}
            className="text-muted-foreground hover:text-foreground shrink-0"
            aria-label="Edit estimated home value"
          >
            <Pencil className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

function RateTermRecRow({ loan, details, homeValueStat }: { loan: TrackedLoan; details: RecDetails; homeValueStat: React.ReactNode }) {
  const { adjustedTodayRate, currentBalance, baseClosingCosts, monthlyEscrow } = details;
  const [financeFees, setFinanceFees] = useState(true);
  const [includeEscrows, setIncludeEscrows] = useState(false);

  const escrowAmount = includeEscrows ? monthlyEscrow * ESCROW_RESERVE_MONTHS : 0;
  const totalFees = baseClosingCosts + escrowAmount;
  const newLoanAmount = currentBalance + (financeFees ? totalFees : 0);
  const newMonthlyPI = calculateMonthlyPayment(newLoanAmount, adjustedTodayRate, NEW_TERM_YEARS);
  const monthlySavings = loan.currentPI - newMonthlyPI;
  const breakEvenMonths = monthlySavings > 0 ? Math.ceil(totalFees / monthlySavings) : 0;

  const savingsClass = monthlySavings > 0 ? "text-green-700" : "text-red-600";
  const loanIdSafe = loan.id.replace(/[^a-zA-Z0-9]/g, "");

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {homeValueStat}
        <RecStat label="New Rate" value={`${adjustedTodayRate.toFixed(3)}%`} valueClass="text-blue-700" />
        <RecStat label="New Monthly" value={`${formatCurrency(newMonthlyPI)}/mo`} />
        <RecStat
          label="Monthly Savings"
          value={`${monthlySavings > 0 ? "+" : ""}${formatCurrency(monthlySavings)}`}
          valueClass={savingsClass}
        />
        <RecStat
          label="Break-Even"
          value={breakEvenMonths > 0 ? `${breakEvenMonths} mo` : "N/A"}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground pt-1">
        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
          <Switch id={`finance-fees-${loanIdSafe}`} checked={financeFees} onCheckedChange={setFinanceFees} />
          <Label htmlFor={`finance-fees-${loanIdSafe}`} className="text-xs cursor-pointer">
            Finance fees in new loan <span className="text-muted-foreground/80">({formatCurrency(baseClosingCosts)})</span>
          </Label>
        </div>
        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
          <Switch id={`include-escrows-${loanIdSafe}`} checked={includeEscrows} onCheckedChange={setIncludeEscrows} disabled={monthlyEscrow <= 0} />
          <Label htmlFor={`include-escrows-${loanIdSafe}`} className={`text-xs cursor-pointer ${monthlyEscrow <= 0 ? "opacity-50" : ""}`}>
            Include escrows ({ESCROW_RESERVE_MONTHS}-mo reserve{monthlyEscrow > 0 ? ` · ${formatCurrency(monthlyEscrow * ESCROW_RESERVE_MONTHS)}` : ""})
          </Label>
        </div>
        <span className="ml-auto">
          New loan amount: <span className="font-semibold text-foreground">{formatCurrency(newLoanAmount)}</span>
        </span>
      </div>
    </div>
  );
}

function RecOverview({
  loan,
  details,
  onUpdateHomeValue,
}: {
  loan: TrackedLoan;
  details: RecDetails;
  onUpdateHomeValue: (v: number) => void;
}) {
  const { rec, adjustedTodayRate, heAvailable, heRate, heMonthly } = details;

  const homeValueStat = <HomeValueStat value={loan.estimatedHomeValue} onSave={onUpdateHomeValue} />;

  if (rec.type === "rate_term") {
    return <RateTermRecRow loan={loan} details={details} homeValueStat={homeValueStat} />;
  }

  if (rec.type === "second_lien") {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {homeValueStat}
        <RecStat label="Equity Available" value={formatCurrency(heAvailable)} valueClass="text-yellow-800" />
        <RecStat label="2nd Lien Rate" value={`${heRate.toFixed(3)}%`} />
        <RecStat label="Est. Monthly" value={heMonthly > 0 ? `${formatCurrency(heMonthly)}/mo` : "—"} />
        <RecStat label="1st Lien Stays" value={`${loan.currentRate}%`} />
      </div>
    );
  }

  // hold
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
      {homeValueStat}
      <RecStat label="Your Rate" value={`${loan.currentRate}%`} valueClass="text-green-700" />
      <RecStat label="Today's Rate" value={`${adjustedTodayRate.toFixed(3)}%`} />
      <RecStat label="Monthly P&I" value={`${formatCurrency(loan.currentPI)}/mo`} />
      <RecStat label="Action" value="Hold" />
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────
function EmptyState({ icon, title, body, cta, href }: {
  icon: React.ReactNode; title: string; body: string; cta: string; href: string;
}) {
  const [, setLocation] = useLocation();
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
      <div className="text-muted-foreground/50">{icon}</div>
      <div>
        <p className="font-semibold text-lg">{title}</p>
        <p className="text-muted-foreground text-sm mt-1 max-w-xs mx-auto">{body}</p>
      </div>
      <Button onClick={() => setLocation(href)} className="mt-2 gap-2">
        <Search className="h-4 w-4" /> {cta}
      </Button>
    </div>
  );
}

// ── Refinance Tab ───────────────────────────────────────────────────
interface RecDetails {
  rec: BestOption;
  adjustedTodayRate: number;
  currentBalance: number;
  monthlyEscrow: number;
  baseClosingCosts: number;
  heAvailable: number;
  heRate: number;
  heMonthly: number;
}

const ESCROW_RESERVE_MONTHS = 3;

function RefiTab() {
  const [, setLocation] = useLocation();
  const [loans, setLoans] = useState<TrackedLoan[]>(() => getTrackedLoans() as TrackedLoan[]);

  // Re-sync whenever Supabase hydrates / user logs in or out.
  useEffect(() => {
    const unsub = subscribeAuthChange(() => setLoans(getTrackedLoans() as TrackedLoan[]));
    return unsub;
  }, []);

  const { data: ratesData } = useQuery<LiveRatesResponse>({ queryKey: ["/api/rates"] });
  const liveRates = ratesData?.rates ?? [];

  function remove(id: string) {
    const updated = loans.filter(l => l.id !== id);
    setLoans(updated);
    saveTrackedLoans(updated);
  }

  function updateHomeValue(id: string, newValue: number) {
    if (typeof newValue !== "number" || !Number.isFinite(newValue) || newValue < 0) return;
    const updated = loans.map(l => l.id === id ? { ...l, estimatedHomeValue: newValue } : l);
    setLoans(updated);
    saveTrackedLoans(updated);
    // Mirror refinance → seller: when the user edits Est. Home
    // Value from the dashboard, push the new value into the
    // matching seller_scenarios row (same property by normalized
    // key). Source-based merge protects manual seller edits.
    try {
      const editedLoan = updated.find(l => l.id === id);
      if (!editedLoan) return;
      const result = createOrUpdateSellerScenarioFromRefinance({
        trackedLoan: editedLoan,
        scenarios: getSellerScenarios(),
      });
      if (result?.changed) {
        saveSellerScenarios(result.scenarios);
      }
    } catch (err) {
      console.warn("[home-value-sync] refinance→seller failed:", err);
    }
  }

  function getRecDetails(loan: TrackedLoan): RecDetails {
    const bestRate = getBestConventionalRate(liveRates);
    const rateAdj = PROPERTY_TYPE_ADJUSTMENTS[loan.propertyType] ?? 0;
    const adjustedTodayRate = (bestRate?.rate ?? FALLBACK_TODAY_RATE) + rateAdj;

    const { currentBalance } = resolveTrackedLoanBalance(loan);

    const rec = getBestOption(
      { ...loan, loanBalance: currentBalance },
      adjustedTodayRate,
      loan.propertyType
    );

    const baseClosingCosts = (currentBalance * CLOSING_COST_PERCENT) / 100 + CLOSING_COST_FIXED;
    const monthlyEscrow = Math.max(0, loan.monthlyPayment - loan.currentPI);

    const maxCltv = HE_MAX_CLTV[loan.propertyType] ?? 0.9;
    const heAvailable = Math.max(0, Math.floor(loan.estimatedHomeValue * maxCltv - currentBalance));
    const heRate = adjustedTodayRate + HE_RATE_MARGIN;
    const heMonthly = heAvailable > 0 ? calculateMonthlyPayment(heAvailable, heRate, 15) : 0;

    return {
      rec,
      adjustedTodayRate,
      currentBalance,
      monthlyEscrow,
      baseClosingCosts,
      heAvailable,
      heRate,
      heMonthly,
    };
  }

  if (loans.length === 0) {
    return (
      <EmptyState
        icon={<RefreshCw className="h-12 w-12" />}
        title="No refinance loans saved yet"
        body="Upload a mortgage statement on the refinance page to analyze and save your loan."
        cta="Go to Refinance"
        href="/refinance"
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Header: Loan Dashboard count + Analyze Another trigger (moved from bottom) */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Loan Dashboard</h3>
          <Badge variant="secondary">{loans.length}/10</Badge>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-2"
          onClick={() => setLocation("/refinance")}
          data-testid="analyze-another-mortgage-statement"
        >
          <RefreshCw className="h-4 w-4" />
          <span>Analyze Another Mortgage Statement</span>
        </Button>
      </div>

      {loans.map(loan => {
        const details = getRecDetails(loan);
        const { rec } = details;
        return (
          <Card
            key={loan.id}
            className="group relative hover:shadow-md transition-shadow overflow-hidden"
          >
            <CardContent
              className="py-4 cursor-pointer"
              onClick={() => setLocation("/refinance")}
            >
              <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                {/* Address + meta */}
                <div className="flex-1 min-w-0 lg:max-w-xs">
                  <div className="flex items-start gap-2">
                    <MapPin className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="font-semibold text-sm leading-snug line-clamp-2">{loan.propertyAddress}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{loan.lender}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                        <Calendar className="h-3 w-3" /> Saved {formatDate(loan.addedAt)}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Property type badge */}
                <div className="flex lg:block">
                  <Badge variant="outline" className={`text-xs ${PROPERTY_TYPE_COLORS[loan.propertyType] || ""}`}>
                    {PROPERTY_TYPE_LABELS[loan.propertyType] || loan.propertyType}
                  </Badge>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm flex-1">
                  <div>
                    <p className="text-xs text-muted-foreground">Balance</p>
                    <p className="font-semibold">{formatCurrency(loan.loanBalance)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Rate</p>
                    <p className="font-semibold">{loan.currentRate}%</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Monthly P&amp;I</p>
                    <p className="font-semibold">{formatCurrency(loan.currentPI)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Est. Value</p>
                    <p className="font-semibold">{formatCurrency(loan.estimatedHomeValue)}</p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2 lg:shrink-0 items-center">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1 text-xs"
                    onClick={e => { e.stopPropagation(); setLocation("/refinance"); }}
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </Button>
                  <AlertBell
                    scenarioId={loan.id}
                    scenarioType="refinance"
                    availableAlertTypes={["rate_drop"]}
                    propertyAddress={loan.propertyAddress}
                    loanType={loan.loanType}
                    loanTermYears={30}
                    occupancyType={loan.propertyType}
                    creditScore={loan.creditScore}
                  />
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive px-2"
                        onClick={e => e.stopPropagation()}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent onClick={e => e.stopPropagation()}>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove this loan?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will remove {loan.propertyAddress} from your saved scenarios. You can re-analyze it anytime.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => remove(loan.id)} className="bg-destructive hover:bg-destructive/90">
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            </CardContent>

            <div className={`border-t p-4 space-y-3 ${rec.cardBg}`} onClick={e => e.stopPropagation()}>
              <div className="flex items-start gap-3">
                <rec.Icon className="h-5 w-5 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <p className="font-semibold text-sm">Recommended:</p>
                    <Badge variant="outline" className={`text-xs ${rec.badgeClass}`}>{rec.label}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{rec.reason}</p>
                </div>
              </div>

              <RecOverview
                loan={loan}
                details={details}
                onUpdateHomeValue={v => updateHomeValue(loan.id, v)}
              />
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ── Address search sub-component ────────────────────────────────────
function AddressSearchBar({ onNavigate, compact = false }: {
  onNavigate: (addr: string) => void;
  compact?: boolean;
}) {
  const { bindInputRef, inputRef } = useGooglePlaces({
    onPlaceSelected: place => onNavigate(place.formatted_address),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const val = inputRef.current?.value?.trim();
    if (val) onNavigate(val);
  }

  if (compact) {
    return (
      <form onSubmit={handleSubmit} className="flex gap-2 max-w-xl">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            ref={bindInputRef}
            type="text"
            placeholder="Enter a property address..."
            autoFocus
            className="w-full pl-9 pr-4 h-10 text-sm rounded-lg border bg-background outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <Button type="submit" size="sm" className="h-10">Analyze</Button>
      </form>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-12 px-4">
      <div className="w-full max-w-2xl text-center">
        <h2 className="text-2xl font-bold mb-2">What is the full cost of this home?</h2>
        <p className="text-muted-foreground mb-8">
          Enter any property address to see your mortgage payment, insurance, taxes, and whether you qualify — no questionnaire required.
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
            <input
              ref={bindInputRef}
              type="text"
              placeholder="Enter a property address..."
              className="w-full pl-10 pr-4 h-14 text-base rounded-xl border bg-background shadow-sm outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <Button type="submit" size="lg" className="h-14 px-8 rounded-xl font-semibold text-base">
            Get Estimate
          </Button>
        </form>
        <p className="text-muted-foreground/60 text-sm mt-4">No questionnaire · Instant results · Free to use</p>
      </div>
    </div>
  );
}

// ── Purchase Tab — saved address tabs + full estimate view ───────────
function PurchaseTab() {
  const [, setLocation] = useLocation();
  const [scenarios, setScenarios] = useState<ReturnType<typeof getPurchaseScenarios>>([]);
  const [showAddSearch, setShowAddSearch] = useState(false);

  // Reload on mount and re-sync whenever Supabase hydrates / login changes.
  useEffect(() => {
    const s0 = getPurchaseScenarios();
    setScenarios(s0);
    console.debug("[purchase-live-load] final displayed count", s0.length, "(PurchaseTab mount)");
    const unsub = subscribeAuthChange(() => {
      const next = getPurchaseScenarios();
      setScenarios(next);
      console.debug("[purchase-live-load] final displayed count", next.length, "(auth-change)");
    });
    return unsub;
  }, []);

  function navigate(addr: string) {
    setLocation(`/estimate?address=${encodeURIComponent(addr)}&from=dashboard`);
  }

  function remove(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    const updated = scenarios.filter(s => s.id !== id);
    setScenarios(updated);
    savePurchaseScenarios(updated);
  }

  // No saved scenarios yet → full search experience
  if (scenarios.length === 0 && !showAddSearch) {
    return <AddressSearchBar onNavigate={navigate} />;
  }

  return (
    <div className="space-y-5">
      {/* Address tabs row */}
      <div className="flex flex-wrap items-center gap-2">
        {scenarios.map(s => (
          <button
            key={s.id}
            onClick={() => navigate(s.address)}
            className="group flex items-center gap-1.5 px-3 py-2 rounded-lg border bg-background hover:border-primary hover:bg-accent transition-colors text-sm font-medium max-w-[220px]"
          >
            <MapPin className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary shrink-0" />
            <span className="truncate">{s.address.split(",")[0]}</span>
            <span
              role="button"
              onClick={e => remove(s.id, e)}
              className="ml-0.5 text-muted-foreground hover:text-destructive transition-colors shrink-0 cursor-pointer"
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        ))}
        <button
          onClick={() => setShowAddSearch(v => !v)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-dashed text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors"
        >
          <Search className="h-3.5 w-3.5" /> Add Property
        </button>
      </div>

      {/* Inline address search */}
      {showAddSearch && (
        <div className="flex items-center gap-2">
          <AddressSearchBar onNavigate={addr => { setShowAddSearch(false); navigate(addr); }} compact />
          <Button variant="ghost" size="sm" className="h-10" onClick={() => setShowAddSearch(false)}>Cancel</Button>
        </div>
      )}

      {/* Property rows */}
      <div className="space-y-3">
        {scenarios.map(s => {
          const taxesComplete = hasValidatedPurchasePropertyTax(s);
          const dtiPct = taxesComplete && s.dti != null ? Math.round(s.dti * 100) : null;
          return (
            <Card
              key={s.id}
              className="hover:shadow-md transition-shadow cursor-pointer group relative"
              onClick={() => navigate(s.address)}
            >
              <CardContent className="py-4">
                <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                  {/* Address + meta */}
                  <div className="flex-1 min-w-0 lg:max-w-xs">
                    <div className="flex items-start gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="font-semibold text-sm leading-snug line-clamp-2">{s.address}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                          <Calendar className="h-3 w-3" /> Saved {formatDate(s.savedAt)}
                        </p>
                        {!taxesComplete && (
                          <p className="text-xs text-amber-700 mt-1">
                            Annual property taxes required for complete payment and qualification
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Qualifies badge */}
                  {s.qualifies != null && taxesComplete && (
                    <div className="flex lg:block">
                      <Badge
                        variant="outline"
                        className={`text-xs ${
                          s.qualifies
                            ? "bg-green-50 text-green-700 border-green-200"
                            : "bg-amber-50 text-amber-700 border-amber-200"
                        }`}
                      >
                        {s.qualifies ? "Qualifies" : "Review"}
                      </Badge>
                    </div>
                  )}

                  {/* Stats */}
                  {(s.price != null || s.monthlyPayment != null || s.cashToClose != null || dtiPct != null) && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm flex-1">
                      {s.price != null && (
                        <div>
                          <p className="text-xs text-muted-foreground">Price</p>
                          <p className="font-semibold">{formatCurrency(s.price)}</p>
                        </div>
                      )}
                      {s.monthlyPayment != null && taxesComplete && (
                        <div>
                          <p className="text-xs text-muted-foreground">Est. Payment</p>
                          <p className="font-semibold">{formatCurrency(s.monthlyPayment)}/mo</p>
                        </div>
                      )}
                      {s.cashToClose != null && taxesComplete && (
                        <div>
                          <p className="text-xs text-muted-foreground">Cash to Close</p>
                          <p className="font-semibold">{formatCurrency(s.cashToClose)}</p>
                        </div>
                      )}
                      {dtiPct != null && (
                        <div>
                          <p className="text-xs text-muted-foreground">DTI</p>
                          <p className="font-semibold">{dtiPct}%</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2 lg:shrink-0 items-center">
                    <Button
                      size="sm"
                      className="gap-2"
                      onClick={e => { e.stopPropagation(); navigate(s.address); }}
                    >
                      View Full Estimate <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                    <AlertBell
                      scenarioId={s.id}
                      scenarioType="purchase"
                      availableAlertTypes={["rate_drop", "price_drop"]}
                      propertyAddress={s.address}
                      loanType={s.loanType}
                      loanTermYears={30}
                      currentPrice={s.price}
                    />
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive px-2"
                          onClick={e => e.stopPropagation()}
                          aria-label="Delete estimate"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent onClick={e => e.stopPropagation()}>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this estimate?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will remove {s.address.split(",")[0]} from your dashboard. You can always look it up again later.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => remove(s.id)}
                            className="bg-destructive hover:bg-destructive/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ── Insurance Tab ────────────────────────────────────────────────────
//
// Builds one compact row per *unique property* by correlating Insurance
// scenarios with Purchase scenarios and Refinance (tracked) loans on a
// normalized property key (street# + street + unit + ZIP5 + state). Rows
// match the visual style of the Purchase / Refinance tabs.
//
// Occupancy resolution order, per row:
//   1. Manual override (localStorage, persisted across sessions for this
//      browser — clears auto-correlation once set, per spec).
//   2. Refinance.propertyType from the most-recently-added matching
//      TrackedLoan (TrackedLoan has a typed propertyType column).
//   3. Purchase scenario — currently no occupancy column persisted, so
//      this falls through to "unknown" until a follow-up adds that
//      column. (PurchaseScenario type in lib/auth.ts has no occupancy.)
//   4. "unknown" — surfaced as a "Not selected" dropdown so the user can
//      set it manually.
//
// IMPORTANT: this UI relies only on existing persisted fields
// (InsuranceScenario.annualPremium + coverageType). Richer insurance
// data (rebuild cost, deductibles, carrier, policy type, status) is
// surfaced with "—" placeholders today and will fill in automatically
// once the insurance scenarios table gains those columns; no further
// UI changes will be needed.

const OCCUPANCY_LABELS: Record<OccupancyType, string> = {
  primary: "Primary Residence",
  secondary: "Second Home",
  investment: "Investment",
  unknown: "Not selected",
};

interface InsuranceRow {
  /** Normalized key — stable across address-shape changes. */
  key: string;
  /** Best display address (prefers insurance record, then purchase, then refi). */
  address: string;
  insurance: InsuranceScenario | null;
  purchaseMatches: PurchaseScenario[];
  refiMatches: TrackedLoan[];
  /** Resolved occupancy after override + correlation. */
  occupancy: OccupancyType;
  /** Where the occupancy value came from (for the small subtitle). */
  occupancySource: "manual_override" | "refinance" | "purchase" | "unknown";
  /** ISO timestamp of the most-recent record contributing to this row. */
  lastUpdated: string;
  linkedSources: ("Purchase" | "Refinance" | "Insurance")[];
}

function buildInsuranceRows(
  insuranceScenarios: InsuranceScenario[],
  purchaseScenarios: PurchaseScenario[],
  trackedLoans: TrackedLoan[],
  dismissedKeys: Set<string>,
): InsuranceRow[] {
  // Group every record by its normalized property key. Records whose
  // address can't be parsed get a synthetic per-record key so they never
  // collapse together silently.
  const byKey = new Map<string, {
    address: string;
    insurance: InsuranceScenario | null;
    purchaseMatches: PurchaseScenario[];
    refiMatches: TrackedLoan[];
    sources: Set<"Purchase" | "Refinance" | "Insurance">;
  }>();

  function ensure(key: string, address: string) {
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        address,
        insurance: null,
        purchaseMatches: [],
        refiMatches: [],
        sources: new Set(),
      };
      byKey.set(key, entry);
    }
    return entry;
  }

  // When an address can't be normalized, fall back to the record's own
  // stable id (never the array index) so row keys + localStorage overrides
  // stay attached to the same physical record across re-orders/re-hydration.
  // Insurance first so its address wins as the display preference.
  insuranceScenarios.forEach((ins) => {
    const norm = normalizePropertyKey(ins.address);
    const key = norm.key || `__unparsed_ins_${ins.id}`;
    const entry = ensure(key, ins.address);
    entry.insurance = ins;
    entry.sources.add("Insurance");
  });

  purchaseScenarios.forEach((p) => {
    const norm = normalizePropertyKey(p.address);
    const key = norm.key || `__unparsed_purchase_${p.id}`;
    const entry = ensure(key, p.address);
    if (!entry.insurance && entry.purchaseMatches.length === 0) entry.address = p.address;
    entry.purchaseMatches.push(p);
    entry.sources.add("Purchase");
  });

  trackedLoans.forEach((l) => {
    const norm = normalizePropertyKey(l.propertyAddress);
    const key = norm.key || `__unparsed_refi_${l.id}`;
    const entry = ensure(key, l.propertyAddress);
    if (!entry.insurance && entry.purchaseMatches.length === 0 && entry.refiMatches.length === 0) {
      entry.address = l.propertyAddress;
    }
    entry.refiMatches.push(l);
    entry.sources.add("Refinance");
  });

  // Resolve occupancy + last-updated per row.
  const rows: InsuranceRow[] = [];
  byKey.forEach((entry, key) => {
    // Auto: refi wins because it has a typed propertyType column.
    const newestRefi = [...entry.refiMatches].sort(
      (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
    )[0];

    const override = getOccupancyOverride(key);
    let occupancy: OccupancyType = "unknown";
    let occupancySource: InsuranceRow["occupancySource"] = "unknown";
    if (override) {
      occupancy = override;
      occupancySource = "manual_override";
    } else if (entry.insurance?.occupancyTypeSource === "manual" && entry.insurance.occupancyType) {
      // Insurance card / detail-view manual pick (server-side lock).
      // Survives refresh/logout/login on any device — localStorage
      // override is per-device, so we fall back to the persisted
      // `insurance_scenarios.occupancy_type` whenever the user marked
      // it manual.
      occupancy = entry.insurance.occupancyType as OccupancyType;
      occupancySource = "manual_override";
    } else if (newestRefi) {
      occupancy = newestRefi.propertyType;
      occupancySource = "refinance";
    } else if (entry.insurance?.occupancyType) {
      // Auto-defaulted from a prior Purchase/Refi sync — still better
      // than "unknown" when the refi row has been deleted.
      occupancy = entry.insurance.occupancyType as OccupancyType;
      occupancySource = "refinance";
    }

    // Last-updated: max of all contributing record timestamps.
    const timestamps: string[] = [];
    if (entry.insurance) timestamps.push(entry.insurance.savedAt);
    entry.purchaseMatches.forEach(p => timestamps.push(p.savedAt));
    entry.refiMatches.forEach(l => timestamps.push(l.addedAt));
    const lastUpdated = timestamps.sort().pop() ?? new Date().toISOString();

    rows.push({
      key,
      address: entry.address,
      insurance: entry.insurance,
      purchaseMatches: entry.purchaseMatches,
      refiMatches: entry.refiMatches,
      occupancy,
      occupancySource,
      lastUpdated,
      linkedSources: Array.from(entry.sources),
    });
  });

  // Hide any property the user explicitly deleted from the Insurance tab.
  // The underlying Purchase / Cash / Refi records still exist (and still
  // show on their own tabs) — we just don't surface an Insurance card for
  // them once dismissed.
  const visible = dismissedKeys.size > 0
    ? rows.filter(r => !dismissedKeys.has(r.key))
    : rows;

  // Newest first.
  visible.sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime());
  return visible;
}

function makeInsuranceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ins_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function InsuranceTab() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  // Mirror auth caches into state so the tab re-renders when scenarios
  // load from Supabase or when other tabs update them.
  const [insurance, setInsurance] = useState<InsuranceScenario[]>([]);
  const [purchases, setPurchases] = useState<PurchaseScenario[]>([]);
  const [loans, setLoans] = useState<TrackedLoan[]>([]);
  // Bump to re-resolve rows after a localStorage override change.
  const [overrideBump, setOverrideBump] = useState(0);
  const [showAddSearch, setShowAddSearch] = useState(false);
  // Property keys the user has deleted from the Insurance tab. Persisted
  // per-user in localStorage so the delete sticks across refresh / logout
  // / login on this device and the backfill below never recreates them.
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(
    () => readDismissedInsuranceKeys(userId),
  );
  useEffect(() => {
    setDismissedKeys(readDismissedInsuranceKeys(userId));
  }, [userId]);

  // Delete an Insurance estimate by id. Only removes from
  // `insurance_scenarios` — matching Purchase/Cash/Refi/Seller rows
  // and the shared property_cache row are intentionally left alone
  // (correlation will simply re-resolve on the next render). If the
  // user later re-saves the same address from one of the source
  // flows, the auto-create path will recreate an Insurance row.
  async function handleDeleteInsurance(key: string, id: string | null, address: string) {
    // Snapshot the pre-delete list so we can roll back the Supabase
    // state if the delete fails. The UI itself updates optimistically
    // via the shared auth cache (matching the Purchase / Refi / Seller
    // delete patterns elsewhere in this file); the rollback re-persists
    // and re-notifies so the row reappears on failure.
    const prev = insurance;
    const next = id ? prev.filter(s => s.id !== id) : prev;

    // Record the dismissal FIRST (and persist it) so the backfill sync()
    // — which fires synchronously from saveInsuranceScenarios' notify()
    // below — skips this address instead of recreating the row. The
    // dismissal is what makes the delete stick; deleting the Supabase
    // row alone is not enough because the source Purchase/Cash/Refi
    // scenario still exists.
    //
    // We store BOTH identities the dismissal might be matched against:
    //   • `key` — the row key (normalized property key, or a synthetic
    //     `__unparsed_*` id when the address can't be normalized). Used
    //     by `buildInsuranceRows` to hide the card.
    //   • the trimmed/lowercased address — a stable fallback the backfill
    //     can match for addresses that don't normalize (where the row key
    //     is synthetic and not reconstructable from the address alone).
    const dismissedIdentities = [key, address.trim().toLowerCase()].filter(Boolean);
    const nextDismissed = new Set(dismissedKeys);
    dismissedIdentities.forEach(d => nextDismissed.add(d));
    writeDismissedInsuranceKeys(userId, nextDismissed);
    setDismissedKeys(nextDismissed);

    try {
      if (id) {
        await saveInsuranceScenarios(next);
        setInsurance(next);
      }
      toast({
        title: "Insurance estimate deleted.",
        description: `${address.split(",")[0]} was removed from your Insurance tab.`,
      });
    } catch (err: any) {
      // Restore the deleted row + un-dismiss so the UI doesn't lie about
      // a delete that didn't actually persist.
      try { await saveInsuranceScenarios(prev); } catch { /* surfaced below */ }
      setInsurance(prev);
      const rollbackDismissed = new Set(dismissedKeys);
      dismissedIdentities.forEach(d => rollbackDismissed.delete(d));
      writeDismissedInsuranceKeys(userId, rollbackDismissed);
      setDismissedKeys(rollbackDismissed);
      console.warn("[insurance-delete] failed — rolled back", { key, id, error: err?.message ?? String(err) });
      toast({
        title: "Couldn't delete insurance estimate",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    }
  }

  useEffect(() => {
    async function sync() {
      const ins = getInsuranceScenarios();
      const pur = getPurchaseScenarios();
      const cb = getCashBuyScenarios();
      const tl = getTrackedLoans() as TrackedLoan[];
      setInsurance(ins);
      setPurchases(pur);
      setLoans(tl);
      // Backfill: ensure every Purchase / Cash-Buy / Refi property
      // has a real `insurance_scenarios` row. Older scenarios saved
      // before the auto-create wiring existed had no insurance row,
      // so they rendered as derived (no stable insurance id → no
      // trash icon). The helper is idempotent — `changed=false` when
      // every address already has a matching row — so this never
      // creates duplicates and never overwrites manual edits.
      const addresses: BulkAddress[] = [
        ...pur
          .filter(p => p.address && p.address.trim().length > 0)
          .map(p => ({
            sourceType: "purchase" as const,
            sourceScenarioId: p.id,
            address: p.address,
            // Seed Insurance-tab annualPremium with 0.75% of value
            // for any newly-created rows (spec: insurance-default-075-percent).
            propertyValue: p.price ?? undefined,
            // Carry the Zillow-derived physical property type so the
            // Insurance row's policy type defaults correctly (condo /
            // townhome → HO6). Never overwrites a manual pick downstream.
            propertyType: p.propertyType,
          })),
        ...cb
          .filter(c => c.address && c.address.trim().length > 0)
          .map(c => ({
            sourceType: "cash_buy" as const,
            sourceScenarioId: c.id,
            address: c.address,
            propertyValue: c.purchasePrice ?? undefined,
            propertyType: c.propertyType,
            occupancyType: c.occupancyType as string | undefined,
          })),
        ...tl
          .filter(l => l.propertyAddress && l.propertyAddress.trim().length > 0)
          .map(l => ({
            sourceType: "refinance" as const,
            sourceScenarioId: l.id,
            address: l.propertyAddress,
            propertyValue: l.estimatedHomeValue ?? undefined,
            // Refinance scenarios carry occupancy (not a physical type).
            occupancyType: l.propertyType as string | undefined,
          })),
      ];
      // Skip any property the user explicitly deleted from the Insurance
      // tab — otherwise the backfill would immediately recreate the row
      // from the still-present source scenario and the delete wouldn't
      // stick. Read the dismissed set FRESH from localStorage (via the
      // current session id) because this effect has `[]` deps and runs
      // again on every notify — a stale closure would miss a just-added
      // dismissal.
      const dismissed = readDismissedInsuranceKeys(getSession()?.id ?? null);
      const liveAddresses = dismissed.size > 0
        ? addresses.filter(a => {
            const k = normalizePropertyKey(a.address).key;
            const addrId = a.address.trim().toLowerCase();
            const isDismissed =
              (!!k && dismissed.has(k)) || (!!addrId && dismissed.has(addrId));
            return !isDismissed;
          })
        : addresses;
      if (liveAddresses.length === 0) return;
      const { scenarios, changed } = ensureInsuranceForAddresses(liveAddresses, ins);
      if (!changed) return;
      // Reflect locally so the trash icon appears immediately, before
      // the next notify cycle round-trips through Supabase.
      setInsurance(scenarios);
      try {
        // saveInsuranceScenarios notifies subscribers, which fires
        // this sync() again. On that pass `changed` will be false
        // (helper is idempotent), so no infinite loop.
        await saveInsuranceScenarios(scenarios);
      } catch (err: any) {
        console.warn("[insurance-auto-create] backfill save failed", {
          error: err?.message ?? String(err),
        });
        // Roll back the optimistic backfill so the UI doesn't show
        // delete-enabled rows that aren't actually persisted.
        setInsurance(ins);
        toast({
          title: "Couldn't sync insurance estimates",
          description:
            "Some insurance rows for your existing properties couldn't be saved. Refresh to retry.",
          variant: "destructive",
        });
      }
    }
    void sync();
    return subscribeAuthChange(() => {
      void sync();
    });
  }, []);

  const rows = buildInsuranceRows(insurance, purchases, loans, dismissedKeys);
  // overrideBump deliberately participates in render via this ref read so
  // the lint rule below stays happy without complicating the hook deps.
  void overrideBump;

  // ── Backfill missing policy_type on insurance rows ─────────────────────
  // The detail page already writes `policy_type` on save, but legacy rows
  // (created before this field existed) come back from Supabase with no
  // value. Compute the default from row.occupancy + the linked purchase's
  // physical propertyType, persist it as policy_type_source = "default_rule",
  // and never overwrite a row already marked "manual".
  useEffect(() => {
    if (rows.length === 0) return;
    let next = insurance;
    let changed = false;
    for (const row of rows) {
      const ins = row.insurance;
      if (!ins) continue;
      // Resolve the property type for THIS address from the highest-
      // priority available source: manual insurance pick → Zillow-derived
      // type carried on a Purchase/Cash/Refi scenario → existing insurance
      // snapshot → Single Family fallback. (Cash-buy-only condos are
      // covered because the backfill sync above seeds ins.propertyType.)
      // Dashboard refiMatches (loan-tracker TrackedLoan) carry occupancy
      // only — no physical property type — so they are not a property-type
      // source here. Purchase matches carry the Zillow-derived type.
      const resolved = resolveInsurancePropertyTypeForAddress({
        insurancePropertyType: ins.propertyType,
        insurancePropertyTypeSource: ins.propertyTypeSource,
        sourcePropertyTypes: row.purchaseMatches.map(p => p.propertyType),
      });
      const occ = row.occupancy === "unknown" ? undefined : row.occupancy;
      const def = getDefaultInsurancePolicyType({
        occupancyType: occ,
        propertyType: resolved.propertyType,
      });
      const policyManual = ins.policyTypeSource === "manual";
      const condoForcesHO6 =
        def === "HO6" && isCondoOrTownhomePropertyType(resolved.propertyType);


      if (policyManual) {
        continue;
      }
      if (!def) continue;

      // Persist a property-type snapshot when one isn't stored yet (so
      // cash-buy-only rows keep the Zillow type across reloads). Never
      // overwrites a manual property-type pick.
      const needsPropertyTypeSeed =
        !ins.propertyType && resolved.source !== "fallback";

      // Update policy type when it's missing OR when a condo/townhome
      // property type must force HO6 over a stale non-manual value
      // (spec example 5: overview shows HO3 → must become HO6).
      const needsPolicyUpdate =
        (!ins.policyType && !!def) ||
        (condoForcesHO6 && ins.policyType !== "HO6");

      if (!needsPolicyUpdate && !needsPropertyTypeSeed) continue;

      next = next.map(s =>
        s.id === ins.id
          ? {
              ...s,
              ...(needsPolicyUpdate
                ? { policyType: def, policyTypeSource: "default_rule" as const }
                : {}),
              ...(needsPropertyTypeSeed
                ? { propertyType: resolved.propertyType, propertyTypeSource: "default" as const }
                : {}),
            }
          : s
      );
      if (needsPolicyUpdate) {
      }
      changed = true;
    }
    if (changed) {
      setInsurance(next);
      void saveInsuranceScenarios(next);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insurance, purchases, loans, overrideBump]);

  // ── Backfill flood zone on insurance rows ──────────────────────────────
  // Resolve the FEMA flood zone for any insurance scenario that doesn't
  // already have one saved — directly from the overview, so the card shows
  // Flood AE/VE/X without the user opening the detail view first. Reuses
  // the shared `fetchFloodZone` resolver (same `/api/flood-zone` source the
  // detail view uses — no duplicated/inconsistent logic). Idempotent: once
  // a zone is saved the row is skipped, so the save→notify→sync cycle can't
  // loop. A session-scoped attempted-set stops us re-hammering FEMA for
  // addresses it can't resolve (those stay "—", never fabricated).
  const floodAttemptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (rows.length === 0) return;
    let cancelled = false;
    (async () => {
      const targets = rows
        .map(r => r.insurance)
        .filter((ins): ins is InsuranceScenario => {
          if (!ins) return false;
          const addr = (ins.address ?? "").trim();
          if (!addr) return false;
          const existing = ins.userAnswerSources?.flood_zone;
          if (typeof existing === "string" && existing.trim()) {
            return false;
          }
          if (floodAttemptedRef.current.has(addr.toLowerCase())) return false;
          return true;
        });
      if (targets.length === 0) return;
      const resolved: Record<string, string> = {};
      for (const ins of targets) {
        const addr = ins.address.trim();
        floodAttemptedRef.current.add(addr.toLowerCase());
        try {
          const res = await fetchFloodZone(addr);
          if (res?.zone) resolved[ins.id] = res.zone;
        } catch (err: any) {
          console.log("[insurance-overview-flood] error", addr, err?.message ?? String(err));
        }
      }
      if (cancelled || Object.keys(resolved).length === 0) return;
      // Re-read the live cache so we merge onto the freshest scenarios and
      // never clobber a concurrent edit; only touch the flood keys.
      const current = getInsuranceScenarios();
      const next = current.map(s => {
        const zone = resolved[s.id];
        if (!zone) return s;
        return {
          ...s,
          userAnswerSources: {
            ...(s.userAnswerSources ?? {}),
            flood_zone: zone,
            flood_zone_source: "fema",
          },
        };
      });
      setInsurance(next);
      void saveInsuranceScenarios(next);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insurance, purchases, loans, overrideBump]);

  // Dashboard Insurance card → occupancy dropdown handler.
  //
  // Historically this only wrote a localStorage override (for rows that
  // had no `insurance_scenarios` row yet, e.g. pure Purchase / Refi
  // correlations). That left two problems for rows that DO have an
  // insurance scenario:
  //   1. occupancy_type / occupancy_type_source weren't persisted, so
  //      the change didn't survive logout/login on a different device.
  //   2. policy_type wasn't recomputed, so a Primary→Investment swap on
  //      a Single Family Residence kept showing HO3 on the card until
  //      the user re-opened the detail view.
  //
  // The fix below keeps the localStorage override (still needed for
  // correlation-only rows) AND, when an `insurance_scenarios` row
  // exists, stamps occupancyType / occupancyTypeSource = "manual",
  // recomputes policyType when not user-locked, and autosaves through
  // the same `saveInsuranceScenarios` pipeline used by the detail
  // view. Source guards mirror the detail-view autosave so manual
  // policy picks stay locked.
  function handleOccupancyChange(key: string, next: OccupancyType) {
    setOccupancyOverride(key, next);
    setOverrideBump(n => n + 1);

    const row = rows.find(r => r.key === key);
    const ins = row?.insurance;
    if (!ins) {
      return;
    }
    // Map dashboard's wider OccupancyType ("unknown" included) onto
    // the narrower CashBuyOccupancyType stored on the scenario. An
    // "unknown" pick clears the snapshot so the auto-rule (refi
    // typed propertyType) can resume driving the row.
    const nextOccupancy: CashBuyOccupancyType | undefined =
      next === "primary" || next === "secondary" || next === "investment"
        ? next
        : undefined;
    const propertyType = resolveInsurancePropertyTypeForAddress({
      insurancePropertyType: ins.propertyType,
      insurancePropertyTypeSource: ins.propertyTypeSource,
      sourcePropertyTypes: (row?.purchaseMatches ?? []).map(p => p.propertyType),
    }).propertyType;
    const policyManual = ins.policyTypeSource === "manual";
    const recomputedPolicy = !policyManual
      ? getDefaultInsurancePolicyType({
          occupancyType: nextOccupancy,
          propertyType,
        })
      : undefined;
    const updated: InsuranceScenario = {
      ...ins,
      savedAt: new Date().toISOString(),
      occupancyType: nextOccupancy,
      // Only stamp "manual" when the user picked a concrete occupancy.
      // Resetting to "unknown" clears the lock so future sync can fill
      // it back in.
      occupancyTypeSource: nextOccupancy ? "manual" : undefined,
      ...(recomputedPolicy
        ? { policyType: recomputedPolicy, policyTypeSource: "default_rule" as const }
        : {}),
    };
    if (policyManual) {
    }
    const nextScenarios = insurance.map(s => (s.id === ins.id ? updated : s));
    setInsurance(nextScenarios);
    saveInsuranceScenarios(nextScenarios)
      .then(() => {
      })
      .catch(err => {
        console.log("[insurance-overview-occupancy] save error", err?.message ?? err);
      });
  }

  // Manual "Add Insurance Property" — mirrors SellersTab.openOrCreate.
  // Creates a draft insurance_scenarios row right away so the property
  // shows up in the overview immediately, then navigates to the detail
  // view. Duplicate addresses (same normalized property key OR exact
  // address match) open the existing scenario instead of creating a
  // second row. Occupancy/property use is NOT stored on the insurance
  // scenario itself — buildInsuranceRows already correlates with
  // Purchase/Refi via normalizedPropertyKey, and user overrides are
  // saved in localStorage by setOccupancyOverride.
  function addInsuranceProperty(addr: string) {
    setShowAddSearch(false);
    const trimmed = addr.trim();
    if (!trimmed) return;
    const incomingKey = normalizePropertyKey(trimmed).key;
    const existing = insurance.find(s => {
      if (s.address.toLowerCase().trim() === trimmed.toLowerCase()) return true;
      if (!incomingKey) return false;
      return normalizePropertyKey(s.address).key === incomingKey;
    });
    if (existing) {
      toast({
        title: "Already on your Insurance tab",
        description: "Opening the existing insurance scenario for this property.",
      });
      setLocation(`/insurance?address=${encodeURIComponent(existing.address)}`);
      return;
    }
    const fresh: InsuranceScenario = {
      id: makeInsuranceId(),
      address: trimmed,
      savedAt: new Date().toISOString(),
    };
    const next = [fresh, ...insurance];
    setInsurance(next);
    saveInsuranceScenarios(next);
    setLocation(`/insurance?address=${encodeURIComponent(fresh.address)}`);
  }

  if (rows.length === 0 && !showAddSearch) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4">
        <div className="w-full max-w-xl text-center space-y-4">
          <Shield className="h-10 w-10 mx-auto text-primary" />
          <h2 className="text-2xl font-bold">No saved properties yet</h2>
          <p className="text-muted-foreground">
            Add a property to get an insurance estimate. Properties from
            Purchase or Refinance will also appear here automatically.
          </p>
          <div className="pt-2">
            <AddressSearchBar onNavigate={addInsuranceProperty} compact />
            <p className="text-xs text-muted-foreground mt-2">
              We'll save it to your dashboard so you can come back any time.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setShowAddSearch(v => !v)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-dashed text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors"
          data-testid="add-insurance-property"
        >
          <Search className="h-3.5 w-3.5" /> Add Insurance Property
        </button>
      </div>

      {showAddSearch && (
        <div className="flex items-center gap-2">
          <AddressSearchBar onNavigate={addInsuranceProperty} compact />
          <Button variant="ghost" size="sm" className="h-10" onClick={() => setShowAddSearch(false)}>Cancel</Button>
        </div>
      )}

      <div className="space-y-3">
        {rows.map(row => (
          <InsuranceRowCard
            key={row.key}
            row={row}
            onOccupancyChange={next => handleOccupancyChange(row.key, next)}
            onOpen={() => setLocation(`/insurance?address=${encodeURIComponent(row.address)}`)}
            onDelete={() =>
              handleDeleteInsurance(row.key, row.insurance?.id ?? null, row.address)
            }
          />
        ))}
      </div>
    </div>
  );
}

function InsuranceRowCard({
  row, onOccupancyChange, onOpen, onDelete,
}: {
  row: InsuranceRow;
  onOccupancyChange: (next: OccupancyType) => void;
  onOpen: () => void;
  /** Removes the property from the Insurance tab: deletes the
   *  `insurance_scenarios` row when one exists and records a per-user
   *  dismissal so the backfill never recreates it. Purchase / Cash /
   *  Refi / Seller records are left untouched. */
  onDelete?: () => void;
}) {
  const ins = row.insurance;
  const annual = ins?.annualPremium;
  const monthly = typeof annual === "number" ? annual / 12 : undefined;
  // Policy type display rules (spec: insurance-overview-occupancy-policy-type-live-update):
  //   - If `policyTypeSource === "manual"`, ALWAYS show the persisted
  //     `ins.policyType` — never recompute, never overwrite. This is
  //     the user's explicit pick from the detail view.
  //   - Otherwise compute live from the current row occupancy +
  //     propertyType so a dropdown change updates this label
  //     immediately (the handler's setInsurance() may not have
  //     re-rendered the new policyType yet on the first frame; the
  //     localStorage override + overrideBump always have). Fall back
  //     to the persisted value, then "—".
  const purchaseType = resolveInsurancePropertyTypeForAddress({
    insurancePropertyType: ins?.propertyType,
    insurancePropertyTypeSource: ins?.propertyTypeSource,
    sourcePropertyTypes: row.purchaseMatches.map(p => p.propertyType),
  }).propertyType;
  const occForRule = row.occupancy === "unknown" ? undefined : row.occupancy;
  const policyManual = ins?.policyTypeSource === "manual";
  const computedPolicy = !policyManual
    ? getDefaultInsurancePolicyType({ occupancyType: occForRule, propertyType: purchaseType })
    : null;
  const policyTypeDisplay = policyManual
    ? (ins?.policyType ?? null)
    : (computedPolicy ?? ins?.policyType ?? null);

  // ── Overview detail line: mirror the values the detail view actually
  // holds. Rebuild = Coverage A; Hurricane = the deductible % the user
  // picked in the detail-view simulator (factor_hurrIdx → 2 / 3 / 5 %,
  // defaulting to 2% just like the simulator). AOP deductible, Flood
  // Zone, and Carrier are saved by the detail view inside
  // `user_answer_sources` (aop_deductible / flood_zone / carrier). When a
  // scenario exists we fall back to the standard defaults ($2,500 AOP,
  // "TBD" carrier); Flood Zone shows "—" until FEMA resolution is saved
  // (never fake data).
  const HURRICANE_PCTS = [2, 3, 5];
  const rebuildDisplay = ins?.coverageA != null && Number.isFinite(ins.coverageA)
    ? formatCurrency(ins.coverageA)
    : "—";
  const hurrIdxRaw = Number(ins?.userAnswerSources?.factor_hurrIdx ?? 0);
  const hurrIdx = Number.isInteger(hurrIdxRaw) && hurrIdxRaw >= 0 && hurrIdxRaw < HURRICANE_PCTS.length
    ? hurrIdxRaw : 0;
  const hurricaneDisplay = ins ? `${HURRICANE_PCTS[hurrIdx]}%` : "—";
  const ua = ins?.userAnswerSources;
  const aopRaw = Number(ua?.aop_deductible);
  const aopDisplay = ins
    ? formatCurrency(Number.isFinite(aopRaw) && aopRaw > 0 ? aopRaw : 2500)
    : "—";
  const floodRaw = typeof ua?.flood_zone === "string" ? ua.flood_zone.trim() : "";
  const floodDisplay = floodRaw || "—";
  const carrierRaw = typeof ua?.carrier === "string" ? ua.carrier.trim() : "";
  const carrierDisplay = ins ? (carrierRaw || "TBD") : "—";
  console.debug("[insurance-overview] detail line", {
    key: row.key,
    rebuild: rebuildDisplay,
    aop: aopDisplay,
    hurricane: hurricaneDisplay,
    flood: floodDisplay,
    carrier: carrierDisplay,
  });

  return (
    <Card className="hover:shadow-md transition-shadow group">
      <CardContent className="py-4">
        <div className="flex flex-col lg:flex-row lg:items-center gap-4">
          {/* Address + meta */}
          <div className="flex-1 min-w-0 lg:max-w-xs">
            <div className="flex items-start gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-semibold text-sm leading-snug line-clamp-2">{row.address}</p>
                <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Updated {formatDate(row.lastUpdated)}
                </p>
                {row.linkedSources.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {row.linkedSources.map(src => (
                      <Badge key={src} variant="secondary" className="text-[10px] py-0 px-1.5">{src}</Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/*
            Occupancy dropdown intentionally hidden from the overview
            card (spec: insurance-overview-policy-type-only). The user
            edits Primary / Secondary / Investment inside the detail
            view; the value is still saved on `insurance_scenarios`,
            still drives the Policy Type default rule, and still
            survives refresh/logout/login via `occupancyTypeSource`.
            We render Policy Type below as the single visible badge so
            the card matches the detail view.
          */}

          {/* Insurance stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm flex-1">
            <div>
              <p className="text-xs text-muted-foreground">Annual Premium</p>
              <p className="font-semibold">{annual != null ? `${formatCurrency(annual)}/yr` : "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Monthly</p>
              <p className="font-semibold">{monthly != null ? `${formatCurrency(monthly)}/mo` : "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Policy Type</p>
              <p className="font-semibold truncate" data-testid={`insurance-policy-type-${row.key}`}>
                {policyTypeDisplay ?? "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Status</p>
              <p className="font-semibold">{ins ? "Estimate" : "Not started"}</p>
            </div>
            {/* Detail-line: Rebuild, Hurricane, AOP deductible, Flood
                zone, and Carrier all mirror the detail view's stored
                values (AOP/Carrier fall back to standard defaults;
                Flood stays "—" until a FEMA zone is saved). */}
            <div className="col-span-2 sm:col-span-4 text-[10px] text-muted-foreground/80">
              Rebuild {rebuildDisplay} &nbsp;·&nbsp; AOP {aopDisplay} &nbsp;·&nbsp; Hurricane {hurricaneDisplay} &nbsp;·&nbsp; Flood {floodDisplay} &nbsp;·&nbsp; Carrier {carrierDisplay}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 lg:shrink-0">
            <Button size="sm" className="gap-2" onClick={onOpen}>
              {ins ? "View / Edit" : "Get Quote"} <ExternalLink className="h-3.5 w-3.5" />
            </Button>
            {onDelete && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive px-2"
                    onClick={e => e.stopPropagation()}
                    aria-label="Delete insurance estimate"
                    data-testid={`delete-insurance-${row.key}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent onClick={e => e.stopPropagation()}>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this insurance estimate?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will remove {row.address.split(",")[0]} from your
                      Insurance tab. This cannot be undone. Matching records
                      in Purchase, Refinance, Cash Buy, and Sell Your Home
                      will not be affected.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={onDelete}
                      className="bg-destructive hover:bg-destructive/90"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Dashboard ──────────────────────────────────────────────────
export default function Dashboard() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();

  if (!user) {
    setLocation("/");
    return null;
  }

  const initials = user.name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);

  function handleLogout() {
    logout();
    setLocation("/");
  }

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Dashboard header bar */}
      <div className="bg-white border-b">
        <div className="container mx-auto px-4 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-primary text-white flex items-center justify-center font-bold text-sm shrink-0">
              {initials}
            </div>
            <div>
              <p className="font-semibold">{user.name}</p>
              <p className="text-xs text-muted-foreground">{user.email}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setLocation("/")}
            >
              <Search className="h-4 w-4" /> Search Property
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground hover:text-destructive"
              onClick={handleLogout}
            >
              <LogOut className="h-4 w-4" /> Log Out
            </Button>
          </div>
        </div>
      </div>

      <main className="container mx-auto px-4 py-8 max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">My Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-1">Your saved property scenarios, all in one place.</p>
        </div>

        <DashboardTabs />
      </main>
    </div>
  );
}

// ── Cash Buy Tab — saved cash-purchase scenarios ─────────────────────
// Mirrors PurchaseTab's row/empty-state structure, but:
//   • Pulls from cash_buy_scenarios (own table, RLS by user_id).
//   • Renders cash-specific stats only — no DTI, no monthly payment,
//     no Qualifies/Review badge, no loan type.
//   • Routes to /cash-buy (own editor page) — never /estimate.
function cashBuyCashToCloseSnapshot(s: CashBuyScenario): number | null {
  if (s.cashToClose != null) return s.cashToClose;
  if (s.purchasePrice == null) return null;
  const concession = (() => {
    const mode = s.sellerConcessionsMode ?? "percent";
    const raw = mode === "amount"
      ? (s.sellerConcessionsAmount ?? 0)
      : (s.purchasePrice * ((s.sellerConcessionsPercent ?? 0) / 100));
    return Math.min(raw, s.closingCosts ?? 0);
  })();
  return Math.max(0, Math.round(s.purchasePrice + (s.closingCosts ?? 0) - concession));
}

// Insurance value shown on the dashboard overview. Mirrors the
// precedence used by the cash-buy detail page:
//   1. Manual `homeownersInsurance` (preserved)
//   2. Simulator-supplied `insurancePremiumAnnual`
//   3. Age/construction baseline
// Returns null when there's no price to base a default on.
function cashBuyInsuranceAnnual(s: CashBuyScenario): number | null {
  if (!s.purchasePrice || s.purchasePrice <= 0) return null;
  const oldFlat = calculateDefaultHomeownersInsurance(s.purchasePrice).annualInsurance;
  const legacyManual =
    s.homeownersInsuranceSource == null &&
    (s.homeownersInsurance ?? 0) > 0 &&
    Math.abs((s.homeownersInsurance ?? 0) - oldFlat) > 1;
  if (
    (s.homeownersInsuranceSource === "manual" || legacyManual) &&
    s.homeownersInsurance &&
    s.homeownersInsurance > 0
  ) {
    return s.homeownersInsurance;
  }
  if (s.insurancePremiumAnnual && s.insurancePremiumAnnual > 0) return s.insurancePremiumAnnual;
  const factors: InsuranceFactors = (s.insuranceFactors as InsuranceFactors | undefined) ?? {
    regionKey: "tampa",
    ...DEFAULT_INSURANCE_FACTORS,
  };
  return calcInsurancePremium(s.purchasePrice, factors).mid;
}

// Ongoing monthly carry — matches the "Monthly carrying cost"
// summary on the cash-buy detail page when taxes are validated. A missing
// tax value returns null rather than silently adding $0 to a "total".
function cashBuyMonthlyOngoing(s: CashBuyScenario): number | null {
  if (!hasValidatedCashBuyPropertyTax(s)) return null;
  const taxesMo = (s.propertyTaxes as number) / 12;
  const insAnnual = cashBuyInsuranceAnnual(s) ?? 0;
  const insMo = insAnnual / 12;
  const hoaMo = s.hoaMonthly ?? 0;
  // Flood insurance only adds when the property is in a flood zone
  // (annualFloodIns > 0). Keeps the overview card in sync with the
  // cash-buy detail view's "Monthly carrying cost".
  const floodMo = (s.annualFloodIns ?? 0) / 12;
  return Math.round(taxesMo + insMo + hoaMo + floodMo);
}

const CASH_OCCUPANCY_LABEL: Record<NonNullable<CashBuyScenario["occupancyType"]>, string> = {
  primary: "Primary",
  secondary: "Secondary",
  investment: "Investment",
};

function CashBuyTab() {
  const [, setLocation] = useLocation();
  const [scenarios, setScenarios] = useState<CashBuyScenario[]>([]);
  const [showAddSearch, setShowAddSearch] = useState(false);

  useEffect(() => {
    setScenarios(getCashBuyScenarios());
    const unsub = subscribeAuthChange(() => setScenarios(getCashBuyScenarios()));
    return unsub;
  }, []);

  // Persist a draft cash-buy row immediately on address selection so an
  // address-only scenario survives navigation/refresh/logout even if the
  // user never edits a field (mirrors seller `openOrCreate`).
  function navigate(addr: string, id?: string) {
    let targetId = id;
    if (!targetId) {
      const existing = scenarios.find(
        s => s.address.toLowerCase().trim() === addr.toLowerCase().trim()
      );
      if (existing) {
        targetId = existing.id;
      } else {
        const now = new Date().toISOString();
        const draft: CashBuyScenario = {
          id: (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
            ? crypto.randomUUID()
            : `cashbuy_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          address: addr,
          normalizedPropertyKey: normalizePropertyKey(addr).key || undefined,
          savedAt: now,
          updatedAt: now,
          occupancyType: "primary",
          sellerConcessionsMode: "percent",
          // Phase-2 defaults: 2% auto closing costs, unknown HOA, Zillow
          // will auto-populate price+photos+HOA on the detail page mount.
          purchasePriceSource: "default",
          closingCostsPercent: 2.0,
          closingCostsSource: "default_percent",
          hoaSource: "unknown",
        };
        const next = [draft, ...scenarios];
        setScenarios(next);
        saveCashBuyScenarios(next);
        targetId = draft.id;
      }
    }
    const qs = new URLSearchParams({ address: addr, from: "dashboard" });
    qs.set("id", targetId);
    setLocation(`/cash-buy?${qs.toString()}`);
  }

  function remove(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    const updated = scenarios.filter(s => s.id !== id);
    setScenarios(updated);
    saveCashBuyScenarios(updated);
  }

  if (scenarios.length === 0 && !showAddSearch) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-dashed bg-muted/30 px-4 py-3 flex items-start gap-3">
          <Banknote className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-sm text-muted-foreground">
            Track a cash purchase — no mortgage, no qualifying. Just price, closing
            costs, taxes, and insurance.
          </div>
        </div>
        <AddressSearchBar onNavigate={(addr) => navigate(addr)} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Address quick-tabs row */}
      <div className="flex flex-wrap items-center gap-2">
        {scenarios.map(s => (
          <button
            key={s.id}
            onClick={() => navigate(s.address, s.id)}
            className="group flex items-center gap-1.5 px-3 py-2 rounded-lg border bg-background hover:border-primary hover:bg-accent transition-colors text-sm font-medium max-w-[220px]"
          >
            <MapPin className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary shrink-0" />
            <span className="truncate">{s.address.split(",")[0]}</span>
            <span
              role="button"
              onClick={e => remove(s.id, e)}
              className="ml-0.5 text-muted-foreground hover:text-destructive transition-colors shrink-0 cursor-pointer"
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        ))}
        <button
          onClick={() => setShowAddSearch(v => !v)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-dashed text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors"
        >
          <Search className="h-3.5 w-3.5" /> Add Property
        </button>
      </div>

      {showAddSearch && (
        <div className="flex items-center gap-2">
          <AddressSearchBar
            onNavigate={addr => { setShowAddSearch(false); navigate(addr); }}
            compact
          />
          <Button variant="ghost" size="sm" className="h-10" onClick={() => setShowAddSearch(false)}>
            Cancel
          </Button>
        </div>
      )}

      {/* Property rows — cash-specific stats only */}
      <div className="space-y-3">
        {scenarios.map(s => {
          const ctc = cashBuyCashToCloseSnapshot(s);
          const insAnnual = cashBuyInsuranceAnnual(s);
          const monthlyOngoing = cashBuyMonthlyOngoing(s);
          const taxesComplete = hasValidatedCashBuyPropertyTax(s);
          const occLabel = s.occupancyType ? CASH_OCCUPANCY_LABEL[s.occupancyType] : null;
          return (
            <Card
              key={s.id}
              className="hover:shadow-md transition-shadow cursor-pointer group relative"
              onClick={() => navigate(s.address, s.id)}
            >
              <CardContent className="py-4">
                <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                  <div className="flex-1 min-w-0 lg:max-w-xs">
                    <div className="flex items-start gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="font-semibold text-sm leading-snug line-clamp-2">{s.address}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                          <Calendar className="h-3 w-3" /> Updated {formatDate(s.updatedAt)}
                          {occLabel && <span className="ml-2">· {occLabel}</span>}
                        </p>
                      </div>
                    </div>
                  </div>

                   {/* Six-field overview. 2 cols on mobile, 3 on sm, 6 across
                      on lg so all fields fit on a single row on desktop.
                      Insurance + Ongoing Monthly Costs are derived to match
                       the cash-buy detail page (same helpers); ongoing cost
                       is explicitly unavailable until taxes are entered. */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-4 gap-y-2 text-sm flex-1">
                    {s.purchasePrice != null && (
                      <div>
                        <p className="text-xs text-muted-foreground">Price</p>
                        <p className="font-semibold">{formatCurrency(s.purchasePrice)}</p>
                      </div>
                    )}
                    {ctc != null && (
                      <div>
                        <p className="text-xs text-muted-foreground">Cash to Close</p>
                        <p className="font-semibold">{formatCurrency(ctc)}</p>
                      </div>
                    )}
                    {s.closingCosts != null && (
                      <div>
                        <p className="text-xs text-muted-foreground">Closing Costs</p>
                        <p className="font-semibold">{formatCurrency(s.closingCosts)}</p>
                      </div>
                    )}
                    {taxesComplete ? (
                      <div>
                        <p className="text-xs text-muted-foreground">Annual Taxes</p>
                        <p className="font-semibold">{formatCurrency(s.propertyTaxes as number)}</p>
                      </div>
                    ) : s.purchasePrice != null && (
                      <div>
                        <p className="text-xs text-muted-foreground">Annual Taxes</p>
                        <p className="font-semibold text-amber-700">Unavailable</p>
                        <p className="text-[11px] text-muted-foreground">Enter manually</p>
                      </div>
                    )}
                    {insAnnual != null && (
                      <div data-testid={`cash-overview-insurance-${s.id}`}>
                        <p className="text-xs text-muted-foreground">Insurance Cost</p>
                        <p className="font-semibold">
                          {formatCurrency(insAnnual)}<span className="text-xs font-normal text-muted-foreground">/yr</span>
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          ≈ {formatCurrency(Math.round(insAnnual / 12))}/mo
                        </p>
                      </div>
                    )}
                    {s.purchasePrice != null && (
                      <div data-testid={`cash-overview-monthly-${s.id}`}>
                         <p className="text-xs text-muted-foreground">
                           Ongoing Monthly{monthlyOngoing == null ? " (incomplete)" : ""}
                         </p>
                         {monthlyOngoing == null ? (
                           <p className="font-semibold text-amber-700">Unavailable</p>
                         ) : (
                           <p className="font-semibold">
                             {formatCurrency(monthlyOngoing)}<span className="text-xs font-normal text-muted-foreground">/mo</span>
                           </p>
                         )}
                         {monthlyOngoing == null && (
                           <p className="text-[11px] text-muted-foreground">Enter annual taxes</p>
                         )}
                        {s.hoaMonthly != null && s.hoaMonthly > 0 && (
                          <p className="text-[11px] text-muted-foreground">
                            incl. HOA {formatCurrency(s.hoaMonthly)}
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2 lg:shrink-0 items-center">
                    <Button
                      size="sm"
                      className="gap-2"
                      onClick={e => { e.stopPropagation(); navigate(s.address, s.id); }}
                    >
                      View / Edit <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                    <AlertBell
                      scenarioId={s.id}
                      scenarioType="cash_buy"
                      availableAlertTypes={["price_drop"]}
                      propertyAddress={s.address}
                      currentPrice={s.purchasePrice}
                      normalizedPropertyKey={s.normalizedPropertyKey}
                      zillowUrl={s.zillowCacheKey?.startsWith("url:") ? s.zillowCacheKey.slice(4) : undefined}
                    />
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive px-2"
                          onClick={e => e.stopPropagation()}
                          aria-label="Delete cash buy scenario"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent onClick={e => e.stopPropagation()}>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this cash buy?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will remove {s.address.split(",")[0]} from your Cash Buy dashboard.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => remove(s.id)}
                            className="bg-destructive hover:bg-destructive/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ── Dashboard overview + top-level tabs ───────────────────────────────
// Lets sibling pages (e.g. the new seller detail page) deep-link back to
// the dashboard on a specific tab via /dashboard?tab=sellers. The clean
// `/dashboard` route is the high-level overview, while `?tab=` enters a
// specific workspace.
//
// Stable tab IDs are the source of truth for routing and content. The
// visual order is a per-user preference (drag-and-drop reorder, persisted
// to localStorage) and is decoupled from content selection — the active
// tab is always tracked by ID, never by array index.
// Stable IDs: kept in legacy order for backwards-compat with deep links.
// `cash_buy` is appended on read for users with a pre-existing saved order
// (see readSavedTabOrder), so the visual default for new users is the
// spec's order: purchase → refinance → insurance → for_sale → cash_buy.
const VALID_TABS = ["purchase", "refinance", "insurance", "sellers", "cash_buy"] as const;
type DashboardTabValue = typeof VALID_TABS[number];

// Display labels only. Stable IDs (`purchase`, `refinance`, `insurance`,
// `sellers`, `cash_buy`) are intentionally unchanged so saved
// scenarios, deep links (`?tab=...`), drag-and-drop tab order in
// localStorage, and the data layer all keep working through the
// rename. The new labels match the logged-out service picker on
// `/select-service` so users see the same names end-to-end.
// `short` is the phone-width label so two tabs fit per row without
// clipping; the full `label` shows from the `sm` breakpoint up.
const TAB_META: Record<DashboardTabValue, {
  label: string;
  short: string;
  description: string;
  icon: typeof Home;
}> = {
  purchase: {
    label: "Purchase with Loan",
    short: "Loan",
    description: "Explore financing options, payments, and a purchase plan for your next home.",
    icon: Home,
  },
  refinance: {
    label: "Refinance",
    short: "Refi",
    description: "Review your current loan and compare refinance opportunities.",
    icon: RefreshCw,
  },
  insurance: {
    label: "Insurance",
    short: "Insurance",
    description: "Build a homeowners insurance estimate and request live carrier quotes.",
    icon: Shield,
  },
  sellers: {
    label: "Sell Your Home",
    short: "Sell",
    description: "Estimate your selling costs, payoff, and potential net proceeds.",
    icon: Tag,
  },
  cash_buy: {
    label: "Purchase with Cash",
    short: "Cash",
    description: "Evaluate a cash purchase and keep your buying scenario organized.",
    icon: Banknote,
  },
};

const TAB_CONTENT: Record<DashboardTabValue, () => JSX.Element> = {
  purchase:  () => <PurchaseTab />,
  refinance: () => <RefiTab />,
  insurance: () => <InsuranceTab />,
  sellers:   () => <SellersTab />,
  cash_buy:  () => <CashBuyTab />,
};

function readTabFromSearch(search: string): DashboardTabValue {
  const params = new URLSearchParams(search);
  const t = params.get("tab");
  return (VALID_TABS as readonly string[]).includes(t ?? "") ? (t as DashboardTabValue) : "purchase";
}

function hasSelectedDashboardTab(search: string): boolean {
  const requestedTab = new URLSearchParams(search).get("tab");
  return (VALID_TABS as readonly string[]).includes(requestedTab ?? "");
}

function DashboardOverview({
  tabOrder,
  onSelect,
}: {
  tabOrder: DashboardTabValue[];
  onSelect: (tab: DashboardTabValue) => void;
}) {
  return (
    <section className="mx-auto max-w-4xl">
      <div className="space-y-3" aria-label="Havo services">
        {tabOrder.map((id) => {
          const { label, description, icon: Icon } = TAB_META[id];
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className="group flex w-full items-center gap-4 rounded-xl border bg-card p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 sm:gap-5 sm:p-6"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary sm:h-14 sm:w-14">
                <Icon className="h-6 w-6 sm:h-7 sm:w-7" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-semibold text-foreground sm:text-xl">{label}</span>
                <span className="mt-1 block text-sm leading-6 text-muted-foreground sm:text-base">{description}</span>
              </span>
              <ArrowRight className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Per-user persisted dashboard tab order. We key by user id so each
 *  account keeps its own preference on a shared browser. Falls back
 *  to the default order on a fresh user or on parse failure. */
const TAB_ORDER_STORAGE_PREFIX = "dashboard:tab-order:";

function readSavedTabOrder(userId: string | null | undefined): DashboardTabValue[] {
  const fallback = [...VALID_TABS] as DashboardTabValue[];
  if (!userId || typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(TAB_ORDER_STORAGE_PREFIX + userId);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    // Reconcile against VALID_TABS: drop unknown IDs and append any
    // newly-added tabs the saved order doesn't know about. This keeps
    // old preferences forward-compatible if we ever add a new tab.
    const known = parsed.filter((id): id is DashboardTabValue =>
      (VALID_TABS as readonly string[]).includes(id),
    );
    const missing = (VALID_TABS as readonly DashboardTabValue[]).filter(id => !known.includes(id));
    const merged = [...known, ...missing];
    return merged.length === VALID_TABS.length ? merged : fallback;
  } catch {
    return fallback;
  }
}

function DashboardTabs() {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [tab, setTab] = useState<DashboardTabValue>(() => readTabFromSearch(search));
  const [tabOrder, setTabOrder] = useState<DashboardTabValue[]>(() => readSavedTabOrder(userId));
  const [dragId, setDragId] = useState<DashboardTabValue | null>(null);
  const [overId, setOverId] = useState<DashboardTabValue | null>(null);
  const isOverview = !hasSelectedDashboardTab(search);

  // Re-hydrate order when the signed-in user changes (initial state
  // captured the user from first render, which may have been null).
  useEffect(() => {
    setTabOrder(readSavedTabOrder(userId));
  }, [userId]);

  // Keep state in sync if the URL changes externally (e.g. user clicks a
  // link, hits Back/Forward, or another component sets ?tab=sellers).
  useEffect(() => {
    const next = readTabFromSearch(search);
    setTab(prev => (prev === next ? prev : next));
  }, [search]);

  function handleChange(value: string) {
    const next = (VALID_TABS as readonly string[]).includes(value)
      ? (value as DashboardTabValue)
      : "purchase";
    setTab(next);
    // A selected workspace must always keep its tab in the URL. The bare
    // `/dashboard` route is reserved for the all-services overview.
    setLocation(`/dashboard?tab=${next}`, { replace: true });
  }

  function persistOrder(next: DashboardTabValue[]) {
    setTabOrder(next);
    if (!userId || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(TAB_ORDER_STORAGE_PREFIX + userId, JSON.stringify(next));
    } catch {
      // localStorage quota / privacy mode — order persists for the session only.
    }
  }

  function handleDragStart(id: DashboardTabValue, e: React.DragEvent<HTMLDivElement>) {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    // Required for Firefox to actually start the drag.
    e.dataTransfer.setData("text/plain", id);
  }

  function handleDragOver(id: DashboardTabValue, e: React.DragEvent<HTMLDivElement>) {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOverId(id);
  }

  function handleDrop(targetId: DashboardTabValue, e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const sourceId = dragId;
    setDragId(null);
    setOverId(null);
    if (!sourceId || sourceId === targetId) return;
    const next = [...tabOrder];
    const from = next.indexOf(sourceId);
    const to = next.indexOf(targetId);
    if (from < 0 || to < 0) return;
    next.splice(from, 1);
    next.splice(to, 0, sourceId);
    persistOrder(next);
    // Active tab stays the same — reordering never switches selection.
  }

  function handleDragEnd() {
    setDragId(null);
    setOverId(null);
  }

  if (isOverview) {
    return <DashboardOverview tabOrder={tabOrder} onSelect={handleChange} />;
  }

  return (
    <Tabs value={tab} onValueChange={handleChange}>
      {/* Mobile: 2-column grid (tabs wrap 2 / 2 / 1) so nothing overflows
          off a phone screen. From the `sm` breakpoint up it reverts to the
          original single horizontal row. */}
      <TabsList className="mb-6 grid w-full grid-cols-2 gap-1 h-auto sm:inline-flex sm:w-auto sm:h-10 sm:gap-0">
        {tabOrder.map((id) => {
          const { label, short, icon: Icon } = TAB_META[id];
          const isDragging = dragId === id;
          const isOver = overId === id && dragId !== id;
          return (
            <div
              key={id}
              draggable
              onDragStart={(e) => handleDragStart(id, e)}
              onDragOver={(e) => handleDragOver(id, e)}
              onDrop={(e) => handleDrop(id, e)}
              onDragEnd={handleDragEnd}
              className={`w-full sm:w-auto ${isDragging ? "opacity-50" : ""} ${isOver ? "ring-2 ring-primary rounded-md" : ""}`}
              title="Drag to reorder"
            >
              <TabsTrigger value={id} className="w-full sm:w-auto gap-2 cursor-grab active:cursor-grabbing">
                <Icon className="h-4 w-4 shrink-0" />
                <span className="sm:hidden">{short}</span>
                <span className="hidden sm:inline">{label}</span>
              </TabsTrigger>
            </div>
          );
        })}
      </TabsList>

      {/* Content is always rendered against the stable tab ID — visual
          order has no effect on which scenario list shows. */}
      {(VALID_TABS as readonly DashboardTabValue[]).map((id) => {
        const TabContent = TAB_CONTENT[id];
        return (
          <TabsContent key={id} value={id}>
            <TabContent />
          </TabsContent>
        );
      })}
    </Tabs>);
}

// ── Sellers Tab — saved seller scenarios ─────────────────────────────
// Compact row style mirrors Purchase / Refinance / Insurance. Tapping the
// row (or its "Open" button) routes to /seller?address=&id= where the
// live net-proceeds calculator + Zillow pre-fill lives.
const SELLER_STATUS_LABEL: Record<SellerScenarioStatus, string> = {
  draft: "Draft",
  reviewing: "Reviewing",
  ready_to_list: "Ready to List",
  listed: "Listed",
  sold: "Sold",
};

const SELLER_STATUS_CLASS: Record<SellerScenarioStatus, string> = {
  draft:         "bg-muted text-muted-foreground border-muted-foreground/20",
  reviewing:     "bg-blue-50 text-blue-700 border-blue-200",
  ready_to_list: "bg-amber-50 text-amber-700 border-amber-200",
  listed:        "bg-violet-50 text-violet-700 border-violet-200",
  sold:          "bg-green-50 text-green-700 border-green-200",
};

// Net proceeds for the overview row/card. Delegates to the SAME shared
// helper the detail view uses so the two surfaces can never drift; returns
// null (shown as "—") when there's no sale price yet.
function computeSellerNetProceeds(s: SellerScenario): number | null {
  if (s.estimatedSalePrice == null) return null;
  return calculateSellerNetProceeds(s).estimatedNetProceeds;
}

// "—" fallback for unset numeric/date row fields — matches the dashboard
// convention for partially-populated scenarios.
const EMDASH = "—";
function fmtMoneyOrDash(n: number | null | undefined): string {
  return n == null ? EMDASH : formatCurrency(n);
}

function makeSellerId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `seller_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function SellersTab() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [scenarios, setScenarios] = useState<SellerScenario[]>([]);
  const [showAddSearch, setShowAddSearch] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);

  // Log what the overview rendered for each row — used to confirm the
  // overview shows the same numbers the detail view saved.
  function logOverviewLoad(list: SellerScenario[]) {
    for (const s of list) {
    }
  }

  useEffect(() => {
    const initial = getSellerScenarios();
    setScenarios(initial);
    logOverviewLoad(initial);
    const unsub = subscribeAuthChange(() => {
      const next = getSellerScenarios();
      setScenarios(next);
      logOverviewLoad(next);
    });
    const unsubErr = subscribePersistenceError(e => {
      if (e.table !== "seller_scenarios") return;
      setPersistError(e.message);
      toast({
        title: "For Sale property didn't save",
        description:
          e.message +
          " — re-apply supabase/schema.sql in the Supabase SQL editor to add any missing columns.",
        variant: "destructive",
      });
    });
    return () => { unsub(); unsubErr(); };
  }, [toast]);

  // Create a seller record immediately on address selection (per task spec)
  // so it shows up in the dashboard even if the user never opens the detail
  // page. If a record already exists for the same address, reuse it instead
  // of creating a duplicate.
  function openOrCreate(addr: string) {
    const existing = scenarios.find(
      s => s.address.toLowerCase().trim() === addr.toLowerCase().trim()
    );
    if (existing) {
      setLocation(
        `/seller?address=${encodeURIComponent(existing.address)}&id=${encodeURIComponent(existing.id)}`
      );
      return;
    }
    const now = new Date().toISOString();
    const id = makeSellerId();
    const norm = normalizePropertyKey(addr).key || undefined;
    const fresh: SellerScenario = {
      id,
      address: addr,
      normalizedPropertyKey: norm,
      savedAt: now,
      updatedAt: now,
      realtorCommissionPct: 6,
      sellerClosingCosts: 0,
      buyerConcessions: 0,
      repairBudget: 0,
      otherSellingCosts: 0,
      mortgagePayoff: 0,
      status: "draft",
    };
    const next = [fresh, ...scenarios];
    setScenarios(next);
    saveSellerScenarios(next);
    setLocation(`/seller?address=${encodeURIComponent(addr)}&id=${encodeURIComponent(id)}`);
  }

  function openExisting(s: SellerScenario) {
    setLocation(`/seller?address=${encodeURIComponent(s.address)}&id=${encodeURIComponent(s.id)}`);
  }

  function remove(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    const updated = scenarios.filter(s => s.id !== id);
    setScenarios(updated);
    saveSellerScenarios(updated);
  }

  if (scenarios.length === 0 && !showAddSearch) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4">
        <div className="w-full max-w-xl text-center space-y-4">
          <Tag className="h-10 w-10 mx-auto text-primary" />
          <h2 className="text-2xl font-bold">Thinking about selling?</h2>
          <p className="text-muted-foreground">
            Add your property address to see your estimated sale price and net proceeds after payoff, commission, and closing costs.
          </p>
          <div className="pt-2">
            <AddressSearchBar onNavigate={openOrCreate} compact />
            <p className="text-xs text-muted-foreground mt-2">
              We'll save it to your dashboard so you can come back any time.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {persistError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-sm px-3 py-2">
          <strong>Saving to Supabase failed.</strong> {persistError}
          <div className="text-xs mt-1 opacity-90">
            Re-apply <code>supabase/schema.sql</code> in your Supabase SQL editor (it's idempotent), then refresh.
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {scenarios.map(s => (
          <button
            key={s.id}
            onClick={() => openExisting(s)}
            className="group flex items-center gap-1.5 px-3 py-2 rounded-lg border bg-background hover:border-primary hover:bg-accent transition-colors text-sm font-medium max-w-[220px]"
          >
            <MapPin className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary shrink-0" />
            <span className="truncate">{s.address.split(",")[0]}</span>
            <span
              role="button"
              onClick={e => remove(s.id, e)}
              className="ml-0.5 text-muted-foreground hover:text-destructive transition-colors shrink-0 cursor-pointer"
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        ))}
        <button
          onClick={() => setShowAddSearch(v => !v)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-dashed text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors"
        >
          <Search className="h-3.5 w-3.5" /> Add Seller Property
        </button>
      </div>

      {showAddSearch && (
        <div className="flex items-center gap-2">
          <AddressSearchBar
            onNavigate={addr => { setShowAddSearch(false); openOrCreate(addr); }}
            compact
          />
          <Button variant="ghost" size="sm" className="h-10" onClick={() => setShowAddSearch(false)}>Cancel</Button>
        </div>
      )}

      <div className="space-y-3">
        {scenarios.map(s => {
          const net = computeSellerNetProceeds(s);
          return (
            <Card
              key={s.id}
              className="hover:shadow-md transition-shadow cursor-pointer group relative"
              onClick={() => openExisting(s)}
            >
              <CardContent className="py-4">
                <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                  {s.primaryPhotoUrl ? (
                    <img
                      src={s.primaryPhotoUrl}
                      alt=""
                      className="h-16 w-24 object-cover rounded-md border shrink-0 hidden sm:block"
                      onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : null}

                  <div className="flex-1 min-w-0 lg:max-w-xs">
                    <div className="flex items-start gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="font-semibold text-sm leading-snug line-clamp-2">{s.address}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                          <Calendar className="h-3 w-3" /> Updated {formatDate(s.updatedAt ?? s.savedAt)}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex lg:block">
                    <Badge variant="outline" className={`text-xs ${SELLER_STATUS_CLASS[s.status]}`}>
                      {SELLER_STATUS_LABEL[s.status]}
                    </Badge>
                  </div>

                  {/* Required row stats — always rendered with "—" when unset,
                      per task spec ("never empty boxes"). */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-2 text-sm flex-1">
                    <div>
                      <p className="text-xs text-muted-foreground">Est. Sale Price</p>
                      <p className="font-semibold">{fmtMoneyOrDash(s.estimatedSalePrice)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Closing Costs</p>
                      <p className="font-semibold">
                        {s.estimatedSalePrice == null ? EMDASH : formatCurrency(resolveSellerClosingCosts(s))}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Payoff</p>
                      <p className="font-semibold">{fmtMoneyOrDash(s.mortgagePayoff)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Net Proceeds</p>
                      <p className={`font-semibold ${net == null ? "" : net >= 0 ? "text-green-700" : "text-destructive"}`}>
                        {fmtMoneyOrDash(net)}
                      </p>
                    </div>
                    {/* Estimated capital-gains taxes — now subtracted from Net Proceeds. */}
                    <div>
                      <p className="text-xs text-muted-foreground">Estimated Taxes Due</p>
                      <p className="font-semibold">
                        {s.priorPurchasePrice == null || s.priorPurchasePrice <= 0 || s.primaryResidence2of5 == null
                          ? "—"
                          : fmtMoneyOrDash(getEstimatedSellerTaxesDue(s))}
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-2 lg:shrink-0 items-center">
                    <Button
                      size="sm"
                      className="gap-2"
                      onClick={e => { e.stopPropagation(); openExisting(s); }}
                    >
                      View / Edit <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                    <AlertBell
                      scenarioId={s.id}
                      scenarioType="seller"
                      availableAlertTypes={["price_drop"]}
                      propertyAddress={s.address}
                      currentPrice={s.estimatedSalePrice}
                      normalizedPropertyKey={s.normalizedPropertyKey}
                    />
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive px-2"
                          onClick={e => e.stopPropagation()}
                          aria-label="Delete seller scenario"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent onClick={e => e.stopPropagation()}>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this seller scenario?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will remove {s.address.split(",")[0]} from your dashboard. You can always add it back later.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => remove(s.id)}
                            className="bg-destructive hover:bg-destructive/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
