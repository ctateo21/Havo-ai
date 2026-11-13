import { useEffect, useState } from "react";
import { CalendarCheck, MessageSquare, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
  DrawerClose,
} from "@/components/ui/drawer";
import { useAuth } from "@/context/auth-context";
import { getSession, updateProfileContact } from "@/lib/auth";
import { useQuoteAccess } from "@/context/quote-access-context";
import { authedFetch } from "@/lib/authed-fetch";

/** Work / Follow Up Boss showing line. tel:/sms: need digits only. */
const SHOWING_PHONE = "8132148356";

/**
 * Remembers which addresses already fired the immediate "started" event in
 * this browser session, so rapid repeat clicks don't spam Follow Up Boss.
 * Module-level (survives component remounts); keyed by address → timestamp.
 */
const startedSentAt = new Map<string, number>();
const STARTED_DEDUPE_MS = 60_000;

type ShowingService = "purchase_with_loan" | "purchase_with_cash";
type ContactMethod = "text" | "call";
type ShowingEvent =
  | "showing_request_started"
  | "showing_request_text_selected"
  | "showing_request_call_selected";

/** Resolved contact used for the notification — from the profile (logged-in)
 *  or the guest modal (logged-out). */
type Contact = { name: string; email: string; phone: string };

interface ScheduleShowingButtonProps {
  service: ShowingService;
  address: string;
  /** Only relevant for purchase_with_loan (e.g. "likely_qualifies"). */
  qualificationStatus?: string;
  estimatedPrice?: number;
  normalizedPropertyKey?: string;
  /** Show the "Call or text our team…" helper line. Defaults to true. */
  subtext?: boolean;
  /** Extra wrapper classes for placement-specific spacing. */
  className?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const onlyDigits = (s: string) => (s || "").replace(/\D/g, "");

/**
 * Build an sms: link that pre-fills a body where the device supports it.
 * SMS URL formats differ by platform: iOS historically uses `&body=`, while
 * Android uses `?body=`. We can't reliably detect the SMS app, so we use the
 * broadly-compatible `?&body=` form (works on modern iOS + Android); if a
 * device ignores the body it simply opens the thread to the number, which is
 * the acceptable fallback.
 */
function buildSmsLink(phone: string, message: string): string {
  if (!message) return `sms:${phone}`;
  return `sms:${phone}?&body=${encodeURIComponent(message)}`;
}

/**
 * "Schedule your showing now" CTA.
 *
 * Logged-in: pulls name/email/phone from the profile/session and IMMEDIATELY
 * fires a non-blocking Follow Up Boss + email notification (showing_request_started),
 * then opens the Call/Text sheet. Logged-in users are never re-prompted unless
 * their email is missing.
 *
 * Logged-out guest: opens a contact-info modal first (Name/Email/Phone, all
 * required + validated). Only after they submit do we send the notification,
 * then open the Call/Text sheet. No account/password/credit card required.
 *
 * Each Call/Text choice fires its own FUB event and opens the sms:/tel: link.
 * Telephony is never blocked if a notification fails (keepalive lets the
 * request survive navigation). Repeat clicks for the same address are
 * de-duplicated for ~60s so FUB isn't spammed.
 */
export function ScheduleShowingButton({
  service,
  address,
  qualificationStatus,
  estimatedPrice,
  normalizedPropertyKey,
  subtext = true,
  className,
}: ScheduleShowingButtonProps) {
  const { user } = useAuth();
  const { requireAccount } = useQuoteAccess();
  const [open, setOpen] = useState(false); // Call/Text sheet
  const [contactOpen, setContactOpen] = useState(false); // guest contact modal
  const [form, setForm] = useState<Contact>({ name: "", email: "", phone: "" });
  const [errors, setErrors] = useState<Partial<Contact>>({});
  // The contact details used for THIS request — set when the sheet opens, so
  // the later Text/Call events reuse the same name/email/phone.
  const [activeContact, setActiveContact] = useState<Contact>({ name: "", email: "", phone: "" });
  // True when the contact modal is shown to a logged-in user (missing phone or
  // email), so the submitted details get saved back to their profile.
  const [modalForLoggedIn, setModalForLoggedIn] = useState(false);

  useEffect(() => {
  }, [service, address, qualificationStatus]);

  function notifyFub(eventType: ShowingEvent, contactMethod: ContactMethod | null, contact: Contact) {
    if (!getSession()) return;
    try {
      const fullName = (contact.name || "").trim();
      const spaceIdx = fullName.indexOf(" ");
      const firstName =
        spaceIdx > 0
          ? fullName.slice(0, spaceIdx)
          : fullName || (contact.email ? contact.email.split("@")[0] : "");
      const lastName = spaceIdx > 0 ? fullName.slice(spaceIdx + 1) : "-";
      // keepalive lets this complete even as the sms:/tel: link opens.
      authedFetch("/api/fub/showing-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          eventType,
          contactMethod,
          address,
          service,
          qualificationStatus,
          estimatedPrice,
          normalizedPropertyKey,
          pageUrl: typeof window !== "undefined" ? window.location.href : "",
          firstName: firstName || undefined,
          lastName,
          email: contact.email || undefined,
          phone: contact.phone || undefined,
          agent: user?.agent || "Team",
          userId: user?.id || undefined,
        }),
      })
        .then(async (res) => {
          if (!res.ok) {
            console.warn("[showing-notification] FUB error", res.status);
            console.warn("[showing-notification] email error", res.status);
            return;
          }
          let data: any = {};
          try {
            data = await res.json();
          } catch {
            /* response body is optional */
          }
        })
        .catch((err) => {
          console.warn("[showing-notification] FUB error", err);
          console.warn("[showing-notification] email error", err);
        });
    } catch (err) {
      console.warn("[showing-notification] error", err);
    }
  }

  /** Fire the immediate "started" notification, de-duped per address. */
  function fireStarted(contact: Contact) {
    const key = `${service}:${(address || "").trim().toLowerCase()}`;
    const hasAddress = (address || "").trim().length > 0;
    const last = startedSentAt.get(key) ?? 0;
    if (!hasAddress || Date.now() - last > STARTED_DEDUPE_MS) {
      startedSentAt.set(key, Date.now());
      notifyFub("showing_request_started", null, contact);
    } else {
    }
  }

  /** Open the Call/Text sheet with a known contact (after notification sent). */
  function openCallTextSheet(contact: Contact) {
    setActiveContact(contact);
    setOpen(true);
  }

  async function handleScheduleClick() {
    if (!getSession() && !await requireAccount()) return;
    const session = getSession();
    const loggedIn = Boolean(session);

    if (loggedIn) {
      const contact: Contact = {
        name: (session?.name || "").trim(),
        email: (session?.email || "").trim(),
        phone: (session?.phone || "").trim(),
      };

      // Prompt the contact modal only when a required field is missing from the
      // profile — email (needed to match the FUB contact) or phone (so the team
      // can reach the lead). The submitted values are saved back to the profile.
      if (!contact.email || !contact.phone) {
        setModalForLoggedIn(true);
        setForm({ name: contact.name, email: contact.email, phone: contact.phone });
        setErrors({});
        setContactOpen(true);
        return;
      }

      fireStarted(contact);
      openCallTextSheet(contact);
      return;
    }

    // Logged-out guest: collect contact info BEFORE sending anything.
    setModalForLoggedIn(false);
    setForm({ name: "", email: "", phone: "" });
    setErrors({});
    setContactOpen(true);
  }

  async function handleContactSubmit() {
    if (!getSession() && !await requireAccount()) return;
    const name = form.name.trim();
    const email = form.email.trim();
    const phone = form.phone.trim();

    const next: Partial<Contact> = {};
    if (!name) next.name = "Please enter your name.";
    if (!email) next.email = "Please enter your email.";
    else if (!EMAIL_RE.test(email)) next.email = "Please enter a valid email address.";
    if (!phone) next.phone = "Please enter your phone number.";
    else if (onlyDigits(phone).length < 10) next.phone = "Please enter a valid phone number.";

    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    setErrors({});
    const contact: Contact = { name, email, phone };
    // A logged-in user filled in a missing phone (or email/name) — save it back
    // to their profile FIRST so the saved profile is the source of truth, then
    // send. We don't hard-block the showing request if the save fails, but the
    // notification still carries the values the user just entered.
    if (modalForLoggedIn) {
      const saved = await updateProfileContact({ phone, name, email });
      if (!saved.ok) {
        console.warn("[showing-contact] profile save failed, sending anyway");
      }
    }
    setContactOpen(false);
    fireStarted(contact);
    openCallTextSheet(contact);
  }

  function handleText() {
    notifyFub("showing_request_text_selected", "text", activeContact);
    const message = `I'd like to schedule a showing for ${address}.`;
    const link = buildSmsLink(SHOWING_PHONE, message);
    setOpen(false);
    if (typeof window !== "undefined") window.location.href = link;
  }

  function handleCall() {
    notifyFub("showing_request_call_selected", "call", activeContact);
    const link = `tel:${SHOWING_PHONE}`;
    setOpen(false);
    if (typeof window !== "undefined") window.location.href = link;
  }

  return (
    <div className={className}>
      <Button
        size="lg"
        className="w-full sm:w-auto"
        onClick={handleScheduleClick}
        data-testid="button-schedule-showing"
      >
        <CalendarCheck className="h-4 w-4 mr-2" />
        Schedule your showing now
      </Button>
      {subtext && (
        <p className="text-xs text-muted-foreground mt-1.5">
          Call or text our team to schedule a showing.
        </p>
      )}

      {/* Guest (or email-less) contact-info modal — collected before sending. */}
      <Dialog open={contactOpen} onOpenChange={setContactOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Schedule your showing</DialogTitle>
            <DialogDescription>
              Enter your contact information so our team can follow up about this property.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="showing-name">Name</Label>
              <Input
                id="showing-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Your name"
                data-testid="input-showing-name"
              />
              {errors.name && (
                <p className="text-xs text-destructive" data-testid="error-showing-name">
                  {errors.name}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="showing-email">Email</Label>
              <Input
                id="showing-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="you@example.com"
                data-testid="input-showing-email"
              />
              {errors.email && (
                <p className="text-xs text-destructive" data-testid="error-showing-email">
                  {errors.email}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="showing-phone">Phone Number</Label>
              <Input
                id="showing-phone"
                type="tel"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="(813) 555-0123"
                data-testid="input-showing-phone"
              />
              {errors.phone && (
                <p className="text-xs text-destructive" data-testid="error-showing-phone">
                  {errors.phone}
                </p>
              )}
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="ghost"
              onClick={() => setContactOpen(false)}
              data-testid="button-showing-contact-cancel"
            >
              Cancel
            </Button>
            <Button onClick={handleContactSubmit} data-testid="button-showing-contact-continue">
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm">
            <DrawerHeader className="text-center">
              <DrawerTitle>Schedule your showing</DrawerTitle>
              <DrawerDescription>
                Would you like to call or text us about this property?
              </DrawerDescription>
            </DrawerHeader>
            <div className="flex flex-col gap-3 px-4">
              <Button
                size="lg"
                className="w-full"
                onClick={handleText}
                data-testid="button-showing-text"
              >
                <MessageSquare className="h-4 w-4 mr-2" />
                Text us
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="w-full"
                onClick={handleCall}
                data-testid="button-showing-call"
              >
                <Phone className="h-4 w-4 mr-2" />
                Call us
              </Button>
            </div>
            <DrawerFooter>
              <DrawerClose asChild>
                <Button variant="ghost" className="w-full" data-testid="button-showing-cancel">
                  Cancel
                </Button>
              </DrawerClose>
            </DrawerFooter>
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
