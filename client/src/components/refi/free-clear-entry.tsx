import { useState } from "react";
import { useAnonymousDraft } from "@/hooks/use-anonymous-draft";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddressAutocompleteInput } from "@/components/ui/address-autocomplete-input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, KeyRound } from "lucide-react";
import { getSession, type TrackedLoan, type TrackedLoanPropertyType, type TrackedLoanType } from "@/lib/auth";

interface FreeClearEntryProps {
  creditScore: number;
  onCreateLoan: (loan: TrackedLoan) => void;
}

const OCCUPANCY_OPTIONS: { value: TrackedLoanPropertyType; label: string }[] = [
  { value: "primary", label: "Primary Home" },
  { value: "secondary", label: "Secondary Home" },
  { value: "investment", label: "Investment Property" },
];

const LOAN_TYPE_OPTIONS: { value: TrackedLoanType; label: string; primaryOnly?: boolean }[] = [
  { value: "conventional", label: "Conventional" },
  { value: "va", label: "VA", primaryOnly: true },
  { value: "fha", label: "FHA", primaryOnly: true },
  { value: "dscr", label: "DSCR" },
  { value: "bank_statement", label: "Bank Statement" },
];

/** No-lien entry: the property is owned outright, so the only analysis
 *  that applies is a 1st-lien cash-out refinance. */
export function FreeClearEntry({ creditScore, onCreateLoan }: FreeClearEntryProps) {
  const [address, setAddress] = useAnonymousDraft("freeClear.address", new URLSearchParams(window.location.search).get("address") || "");
  const [homeValue, setHomeValue] = useAnonymousDraft("freeClear.homeValue", "");
  const [occupancy, setOccupancy] = useAnonymousDraft<TrackedLoanPropertyType>("freeClear.occupancy", "primary");
  const [loanType, setLoanType] = useAnonymousDraft<TrackedLoanType>("freeClear.loanType", "conventional");
  const [error, setError] = useState<string | null>(null);

  const num = (s: string) => {
    const n = parseFloat(s.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };

  function handleOccupancyChange(v: TrackedLoanPropertyType) {
    setOccupancy(v);
    // VA/FHA require primary occupancy.
    if (v !== "primary" && (loanType === "va" || loanType === "fha")) {
      setLoanType("conventional");
    }
  }

  function create() {
    if (!address.trim()) { setError("Enter the property address."); return; }
    if (num(homeValue) <= 0) { setError("Enter an estimated home value."); return; }
    setError(null);
    const now = new Date().toISOString();
    onCreateLoan({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      propertyAddress: address.trim(),
      lender: "",
      loanBalance: 0,
      currentRate: 0,
      currentPI: 0,
      monthlyPayment: 0,
      estimatedHomeValue: num(homeValue),
      estimatedRemainingYears: 0,
      addedAt: now,
      balanceAsOf: now,
      propertyType: occupancy,
      occupancyType: occupancy,
      loanType,
      creditScore,
      entryMethod: "free_and_clear",
      freeAndClear: true,
      refiGoal: "cash_out",
    });
    // Keep the anonymous form editable/revisitable along with its calculated
    // draft. In particular a denied new-address attempt must not erase inputs.
    if (getSession()) {
      setAddress("");
      setHomeValue("");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" />Owned Free &amp; Clear
        </CardTitle>
        <CardDescription>
          No mortgage on the property — we'll show what you could pull out with a 1st-lien cash-out refinance.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="fc-address">Property address</Label>
            <AddressAutocompleteInput id="fc-address" data-testid="input-fc-address" placeholder="123 Main St, Tampa, FL" value={address} onValueChange={setAddress} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fc-home-value">Estimated home value</Label>
            <Input id="fc-home-value" data-testid="input-fc-home-value" inputMode="numeric" placeholder="$500,000" value={homeValue} onChange={e => setHomeValue(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Property use</Label>
            <Select value={occupancy} onValueChange={v => handleOccupancyChange(v as TrackedLoanPropertyType)}>
              <SelectTrigger data-testid="select-fc-occupancy"><SelectValue /></SelectTrigger>
              <SelectContent>
                {OCCUPANCY_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Loan type</Label>
            <Select value={loanType} onValueChange={v => setLoanType(v as TrackedLoanType)}>
              <SelectTrigger data-testid="select-fc-loan-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LOAN_TYPE_OPTIONS.filter(o => !o.primaryOnly || occupancy === "primary").map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {occupancy !== "primary" && (
              <p className="text-xs text-muted-foreground">VA and FHA require primary residence.</p>
            )}
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button onClick={create} className="w-full" data-testid="btn-add-free-clear">
          Add Property
        </Button>
      </CardContent>
    </Card>
  );
}
