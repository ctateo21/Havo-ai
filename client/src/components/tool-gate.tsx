import { useEffect, useState, type ReactNode } from "react";
import { Redirect, useLocation, useSearch } from "wouter";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/context/auth-context";
import { useSubscription } from "@/hooks/use-subscription";
import { useQuoteAccess, type QuoteType } from "@/context/quote-access-context";
import { useGooglePlaces } from "@/hooks/use-google-places";

const types: Record<string, QuoteType> = {
  "/estimate": "purchase", "/cash-buy": "cash", "/refinance": "refinance",
  "/insurance": "insurance", "/seller": "seller",
};

export default function ToolGate({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const sub = useSubscription();
  const [path, navigate] = useLocation();
  const search = useSearch();
  const address = new URLSearchParams(search).get("address")?.trim() || "";
  const type = types[path];
  const key = `${type}:${address}`;
  const { authorize } = useQuoteAccess();
  const [allowedKey, setAllowedKey] = useState("");
  const [checking, setChecking] = useState(!!address);
  const [retry, setRetry] = useState(0);
  const [input, setInput] = useState("");
  const { bindInputRef } = useGooglePlaces({
    enabled: !isLoading && !user && !address,
    onPlaceSelected: place => setInput(place.formatted_address),
  });

  useEffect(() => {
    if (isLoading || user || !address || !type) return;
    let active = true;
    setChecking(true);
    void authorize(type, address).then(allowed => {
      if (!active) return;
      if (allowed) setAllowedKey(key);
      setChecking(false);
    });
    return () => { active = false; };
  }, [isLoading, user, address, type, key, authorize, retry]);

  if (isLoading || (user && sub.isLoading) || (!user && checking)) return (
    <div role="status" aria-label="Preparing your quote" className="mx-auto max-w-4xl space-y-5 px-6 py-20">
      <div className="h-8 w-2/3 rounded bg-muted animate-pulse" />
      <div className="h-64 rounded-xl bg-muted animate-pulse" />
    </div>
  );
  if (user) {
    if (!sub.data?.active) return <Redirect to="/subscribe" />;
    return <>{children}</>;
  }
  if (address && allowedKey === key) return <>{children}</>;

  return <section className="mx-auto flex max-w-lg flex-col items-center px-6 py-24 text-center">
    <div className="mb-5 rounded-full bg-muted p-4"><Lock className="h-7 w-7 text-primary" /></div>
    <h1 className="mb-3 text-2xl font-semibold">{address ? "Keep exploring with a free account" : "Run your first quote free, no sign-up needed"}</h1>
    <p className="mb-6 text-muted-foreground">{address
      ? "Your first quote includes edits and return visits. Create an account for another address or quote type, or to save, download, share, email, and request live carrier quotes. Your draft stays here."
      : "Enter a Florida property address. No personal details are needed for your first estimate."}</p>
    {address ? <Button onClick={() => setRetry(value => value + 1)}>Continue / Try again</Button> :
      <form className="flex w-full flex-col gap-3" onSubmit={event => {
        event.preventDefault();
        if (input.trim()) navigate(`${path}?address=${encodeURIComponent(input.trim())}`);
      }}>
        <Input ref={bindInputRef} aria-label="Florida property address" placeholder="Enter a Florida property address" value={input} onChange={event => setInput(event.target.value)} autoComplete="off" required />
        <Button type="submit">Start my quote</Button>
      </form>}
  </section>;
}
