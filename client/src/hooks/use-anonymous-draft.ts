import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { getSession } from "@/lib/auth";
import { hasPendingAnonymousAccountDraft, rememberAnonymousAccountDraft } from "@/lib/anonymous-account-draft";

export function useAnonymousAccountDraft(type: Parameters<typeof rememberAnonymousAccountDraft>[0], payload: unknown) {
  useEffect(() => { rememberAnonymousAccountDraft(type, payload); });
}

function draftKey(field: string) {
  return `havo_quote_draft:${window.location.pathname}:${new URLSearchParams(window.location.search).get("address") || ""}:${field}`;
}

export function readAnonymousDraft<T>(field: string, fallback: T): T {
  if (getSession() && !hasPendingAnonymousAccountDraft()) return fallback;
  try {
    const raw = localStorage.getItem(draftKey(field));
    return raw === null ? fallback : JSON.parse(raw) as T;
  } catch { return fallback; }
}

export function useAnonymousDraftRef<T>(field: string, initial: T) {
  const ref = useRef(readAnonymousDraft(field, initial));
  const key = useRef(draftKey(field));
  const anonymous = useRef(!getSession() || hasPendingAnonymousAccountDraft());
  useEffect(() => {
    if (!anonymous.current || getSession()) return;
    try { localStorage.setItem(key.current, JSON.stringify(ref.current)); } catch { /* Storage unavailable. */ }
  });
  return ref;
}

/**
 * Browser-only, non-authoritative draft. It never grants quote/action access or
 * writes a CRM lead. Page save effects move the mounted draft to the account
 * only after AuthContext receives a real session.
 */
export function useAnonymousDraft<T>(field: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const storageKey = useRef(draftKey(field));
  const anonymous = useRef(!getSession() || hasPendingAnonymousAccountDraft());
  const [value, setValue] = useState<T>(() => {
    if (anonymous.current) {
      try {
        const raw = localStorage.getItem(storageKey.current);
        if (raw !== null) return JSON.parse(raw) as T;
      } catch { /* Private browsing or malformed drafts: use safe defaults. */ }
    }
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  useEffect(() => {
    if (!anonymous.current || getSession()) return;
    try { localStorage.setItem(storageKey.current, JSON.stringify(value)); } catch { /* Keep the in-memory draft. */ }
  }, [value]);
  return [value, setValue];
}
