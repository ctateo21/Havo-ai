import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import AuthDialog from "@/components/ui/auth-dialog";
import { useAuth } from "@/context/auth-context";
import { authedFetch } from "@/lib/authed-fetch";
import { useToast } from "@/hooks/use-toast";
import { promoteAnonymousAccountDraft } from "@/lib/anonymous-account-draft";

export type QuoteType = "purchase" | "cash" | "refinance" | "insurance" | "seller" | "rent";

/** The signed HttpOnly cookie, never localStorage, owns the free-quote allowance. */
export async function startQuote(quoteType: QuoteType, address: string): Promise<boolean> {
  const response = await authedFetch("/api/anonymous-quote/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ quoteType, address }),
  });
  const result = await response.json();
  if (response.status === 401 && result.code === "SIGN_UP_REQUIRED") return false;
  if (!response.ok || result.allowed !== true) {
    throw new Error(result.error || "We couldn't start your quote. Please try again.");
  }
  return true;
}

const QuoteAccessContext = createContext<{
  authorize: (type: QuoteType, address: string) => Promise<boolean>;
  requireAccount: () => Promise<boolean>;
}>({ authorize: async () => false, requireAccount: async () => false });

export function QuoteAccessProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const completedAuth = useRef(false);
  const promotedForUser = useRef<string | null>(null);
  const pending = useRef<{
    type?: QuoteType; address?: string; resolve: (allowed: boolean) => void;
  } | null>(null);

  const authorize = useCallback(async (type: QuoteType, address: string) => {
    if (!address.trim()) return false;
    try {
      if (await startQuote(type, address)) return true;
      pending.current?.resolve(false);
      return await new Promise<boolean>(resolve => {
        pending.current = { type, address, resolve };
        setOpen(true);
      });
    } catch (error) {
      toast({ title: "Quote not started", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
      return false;
    }
  }, [toast]);

  const requireAccount = useCallback(async () => {
    if (user) return true;
    pending.current?.resolve(false);
    return await new Promise<boolean>(resolve => {
      pending.current = { resolve };
      setOpen(true);
    });
  }, [user]);

  useEffect(() => {
    const onRequired = () => setOpen(true);
    window.addEventListener("havo:signup-required", onRequired);
    return () => window.removeEventListener("havo:signup-required", onRequired);
  }, []);

  useEffect(() => {
    // Lead forms and successful signup without an authenticated session do not
    // unlock anything. Wait for the real Supabase user in AuthContext.
    if (!user || !pending.current) return;
    const request = pending.current;
    pending.current = null;
    setOpen(false);
    if (!request.type || !request.address) {
      request.resolve(true);
      return;
    }
    void startQuote(request.type, request.address)
      .then(request.resolve)
      .catch(() => request.resolve(false));
  }, [user]);

  useEffect(() => () => { pending.current?.resolve(false); }, []);

  useEffect(() => {
    if (!user || promotedForUser.current === user.id) return;
    promotedForUser.current = user.id;
    void promoteAnonymousAccountDraft().catch(() => {
      promotedForUser.current = null;
      toast({ title: "Your draft is still on this device", description: "Open your quote and use Save Scenario to retry saving it to your account.", variant: "destructive" });
    });
  }, [user, toast]);

  return <QuoteAccessContext.Provider value={{ authorize, requireAccount }}>
    {children}
    <AuthDialog open={open} defaultTab="register" redirectAfterRegister={false}
      onOpenChange={next => {
        setOpen(next);
        // AuthDialog closes just before AuthContext's render on success.
        // Its onAuthenticated callback below preserves the queued request.
        if (!next && pending.current && !completedAuth.current) {
          pending.current.resolve(false);
          pending.current = null;
        }
        if (!next) completedAuth.current = false;
      }}
      onAuthenticated={() => { completedAuth.current = true; }} />
  </QuoteAccessContext.Provider>;
}

export function useQuoteAccess() { return useContext(QuoteAccessContext); }
