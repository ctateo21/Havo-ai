import { useRef, useState, type FormEvent } from "react";
import { Helmet } from "react-helmet";
import { ArrowDown, ArrowRight, Check, CheckCircle2, FileCheck2, MapPin, ShieldCheck, UserRound, LockKeyhole } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { publicAgentPost, useAgentsExperiment, type AgentInterest, type AgentTier } from "@/hooks/use-agents-experiment";
import "./agents.css";

const tiers: { id: AgentTier; name: string; price: string; description: string }[] = [
  { id: "agent", name: "Agent", price: "$49", description: "For the agent who wants buyers to walk in prepared." },
  { id: "loan_officer", name: "Loan Officer", price: "$79", description: "For the LO helping buyers see beyond principal and interest." },
  { id: "brokerage", name: "Brokerage", price: "Contact us", description: "For a team that wants every client estimate to feel like their own." },
];
const emptyForm: AgentInterest = { name: "", email: "", company: "", role: "realtor", buyersPerYear: "1_10", consent: false, website: "" };

export default function Agents() {
  const { context, track, trackingError } = useAgentsExperiment();
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState<AgentTier>("agent");
  const [form, setForm] = useState<AgentInterest>(emptyForm);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<{ emailStatus: string } | null>(null);
  const submissionId = useRef<string | null>(null);
  const submitting = useRef(false);
  // A failed request may already have committed. Keep both its id and its tier
  // until a successful response so retries remain the same submission.
  const submissionTier = useRef<AgentTier | null>(null);

  function chooseTier(selected: AgentTier) {
    if (success) {
      setForm(emptyForm);
      setSuccess(null);
      submissionId.current = null;
      submissionTier.current = null;
      setError("");
    }
    if (!submissionTier.current) setTier(selected);
    setOpen(true);
    void track("tier_click", selected);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !form.consent) return;
    submitting.current = true;
    setPending(true);
    setError("");
    submissionId.current ??= crypto.randomUUID();
    submissionTier.current ??= tier;
    try {
      const result = await publicAgentPost("/api/agents/interest", {
        ...context, ...form, id: submissionId.current, tier: submissionTier.current,
      });
      if (result.ok !== true) throw new Error("We couldn't confirm your registration. Please try again.");
      setSuccess({ emailStatus: result.emailStatus });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Please try again.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <div className="agents-page">
      <Helmet>
        <title>Havo for agents | The real number before the showing</title>
        <meta name="description" content="County-sourced property taxes, CDD fees, and live insurance quotes. Join the early interest list for Havo for agents in Tampa Bay and Naples." />
      </Helmet>
      <section className="agents-wrap agents-hero" aria-labelledby="agents-title">
        <div>
          <p className="agents-eyebrow">Havo for agents · Coming soon</p>
          <h1 id="agents-title">Send your buyers the real number before the showing.</h1>
          <p className="agents-lede">Havo shows buyers the true monthly cost of a Florida home: county-sourced property taxes, CDD fees, and live insurance quotes. Soon you'll be able to send it to clients under your own name.</p>
          <a className="agents-link" href="#agents-plans">Find your fit <ArrowDown size={17} aria-hidden="true" /></a>
          <p className="mt-4 text-xs text-muted-foreground">An early look. Not a checkout.</p>
        </div>
        <div className="agents-preview" aria-label="Concept preview of a branded estimate. No actual property or pricing shown.">
          <div className="agents-paper">
            <div className="agents-paper-head">
              <div className="flex items-center gap-3">
                <div className="rounded-full bg-[#e4eeea] p-3"><UserRound size={22} aria-hidden="true" /></div>
                <div><p className="text-sm font-semibold">Your name. Your brand.</p><p className="mt-1 text-xs text-muted-foreground">A clearer picture for your buyer</p></div>
              </div>
            </div>
            <div className="mt-6 mb-2">
              <p className="agents-eyebrow">The home behind the listing</p>
              <h2 className="mt-3 text-2xl font-bold leading-tight">The details that<br />change the monthly cost.</h2>
            </div>
            <div className="agents-paper-row"><FileCheck2 size={21} aria-hidden="true" /><div><strong>Property taxes + CDD</strong><small>From the home's county records</small></div></div>
            <div className="agents-paper-row"><ShieldCheck size={21} aria-hidden="true" /><div><strong>Homeowners insurance</strong><small>Live quotes from real carriers</small></div></div>
            <div className="flex items-center gap-2 mt-5 text-xs text-[#007f77]"><CheckCircle2 size={16} aria-hidden="true" />Built around the specific home</div>
          </div>
          <p className="agents-preview-note">Branding concept · Feature not yet available</p>
        </div>
      </section>
      <div className="agents-wrap agents-location">
        <span className="flex items-center gap-2"><MapPin size={17} className="text-[#007f77]" aria-hidden="true" /><strong>Starting local. Tampa Bay + Naples.</strong></span>
        <span>For realtors, loan officers &amp; brokerages</span>
      </div>
      <section className="agents-wrap agents-features" aria-labelledby="agents-details-title">
        <div><p className="agents-eyebrow">Beyond the list price</p><h2 id="agents-details-title" className="agents-section-title">A home is more<br />than its mortgage.</h2><p className="mt-5 text-sm leading-relaxed text-muted-foreground">Give buyers the details that belong in the conversation before they fall in love with the house.</p></div>
        <div>
          <article className="agents-feature"><span className="agents-feature-number">01</span><div><h3>County records. Not a guess.</h3><p>Real property taxes and CDD fees for the specific home, sourced from county records. Because the next street over can be a different story.</p></div></article>
          <article className="agents-feature"><span className="agents-feature-number">02</span><div><h3>Insurance that reflects the home.</h3><p>Live homeowners insurance quotes from real carriers. Put the insurance conversation next to the tax conversation, where it belongs.</p></div></article>
          <article className="agents-feature"><span className="agents-feature-number">03</span><div><h3>Your relationship. Your name.</h3><p>Coming soon: your name, photo, and logo on every client estimate. A useful answer your buyers can keep, with you at the center.</p></div></article>
        </div>
      </section>
      <section id="agents-plans" className="agents-plans" aria-labelledby="agents-plans-title">
        <div className="agents-wrap">
          <div className="agents-plan-heading"><div><p className="agents-eyebrow">Choose your starting point</p><h2 id="agents-plans-title" className="agents-section-title">Built for your side of the table.</h2></div><p>Proposed plans for what comes next. Choose a plan to join the interest list—not to start a subscription.</p></div>
          {tiers.map(plan => <article key={plan.id} className="agents-tier">
            <h3>{plan.name}</h3><p>{plan.description}</p>
            <div className="agents-price">{plan.price}{plan.id !== "brokerage" && <small>per month</small>}</div>
            <button className="agents-button" onClick={() => chooseTier(plan.id)} aria-label={`Start free trial — ${plan.name}`}>Start free trial<ArrowRight size={16} aria-hidden="true" /></button>
          </article>)}
          <p className="agents-note"><LockKeyhole size={17} className="shrink-0 mt-0.5" aria-hidden="true" /><span>Havo for agents isn't open yet. These buttons open an interest form. No card or payment is collected, no trial is started, and no paid features are available.</span></p>
        </div>
      </section>
      <section className="agents-wrap agents-close">
        <div><h2>Local knowledge. A fuller picture.</h2><p>Questions before you join the list? Talk to the people behind Havo.</p></div>
        <a href="mailto:sales@havofl.com" className="agents-link !mt-0">Talk to Havo<ArrowRight size={17} aria-hidden="true" /></a>
      </section>
      {trackingError && <div className="agents-wrap pb-5"><p className="text-xs text-muted-foreground" role="status">We couldn't record some page activity. You can still join the interest list; your registration is confirmed separately.</p></div>}
      <footer className="agents-wrap agents-licenses">
        <p>Real estate license SL3502339 with Horizons By the Sea, Inc.; NMLS #1223755; Florida 2-20 insurance license W142842.</p>
      </footer>
      <Dialog open={open} onOpenChange={value => { if (!submitting.current) setOpen(value); }}>
        <DialogContent className="agents-dialog">
          {success ? <>
            <CheckCircle2 size={36} className="text-[#007f77]" aria-hidden="true" />
            <DialogTitle className="text-2xl leading-tight">You're on the list.</DialogTitle>
            <DialogDescription className="leading-relaxed">Your interest is registered. Christian will reach out about the first group in Tampa Bay and Naples. No trial has started and you haven't been charged.</DialogDescription>
            <p className="agents-message" role="status">{success.emailStatus === "sent" ? "A confirmation email has been sent. You can unsubscribe from launch updates at any time." : success.emailStatus === "suppressed" ? "A confirmation email was not sent. Your email preferences have been respected; your interest is still registered." : "Your registration is saved, but a confirmation email has not been confirmed as sent. You do not need to submit again."}</p>
            <button className="agents-button" onClick={() => setOpen(false)}>Done<Check size={16} aria-hidden="true" /></button>
          </> : <>
            <p className="agents-eyebrow">Early interest · {tiers.find(plan => plan.id === tier)?.name}</p>
            <DialogTitle className="text-2xl leading-tight">Havo for agents isn't open yet.</DialogTitle>
            <DialogDescription className="leading-relaxed">We're onboarding a small first group in Tampa Bay and Naples. Want a spot?</DialogDescription>
            <form onSubmit={submit} className="agents-form" aria-busy={pending}>
              <label>Full name<input className="agents-field" required autoComplete="name" maxLength={120} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
              <label>Email<input className="agents-field" type="email" required autoComplete="email" maxLength={254} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
              <label className="agents-full">Brokerage / company<input className="agents-field" required autoComplete="organization" maxLength={160} value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} /></label>
              <label>Your role<select className="agents-field" required value={form.role} onChange={e => setForm({ ...form, role: e.target.value as AgentInterest["role"] })}><option value="realtor">Realtor</option><option value="loan_officer">Loan Officer</option><option value="broker_owner">Broker or owner</option><option value="insurance_agent">Insurance agent</option></select></label>
              <label>Buyers per year<select className="agents-field" required value={form.buyersPerYear} onChange={e => setForm({ ...form, buyersPerYear: e.target.value as AgentInterest["buyersPerYear"] })}><option value="1_10">1 to 10</option><option value="11_25">11 to 25</option><option value="26_plus">26 or more</option></select></label>
              <div hidden aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} /></label></div>
              <label className="agents-full agents-consent"><input type="checkbox" required checked={form.consent} onChange={e => setForm({ ...form, consent: e.target.checked })} /><span>I agree to receive a confirmation and Havo for agents launch updates by email. I can unsubscribe at any time. <a className="underline" href="/privacy" target="_blank" rel="noreferrer">Privacy policy</a>.</span></label>
              <p className="agents-full text-xs leading-relaxed text-muted-foreground">No card or payment is collected. This joins the interest list only; no trial is started.</p>
              {error && <p className="agents-message agents-error agents-full" role="alert">{error}</p>}
              <button type="submit" className="agents-button agents-full" disabled={pending}>{pending ? "Saving your interest…" : "Join the interest list"}<ArrowRight size={16} aria-hidden="true" /></button>
            </form>
          </>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
