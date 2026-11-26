---
name: Purchase-page inline live quote
description: How the purchase page reuses the Insurance questionnaire, the 90-day reuse rule, and the non-blocking team alert.
---
- The purchase page embeds the Insurance tab's own component (embedded mode), never a copy. **Why:** one qr-start payload, one autosave path, one card per property. **How to apply:** add questionnaire changes to pages/insurance.tsx only; embedded mode disables guest drafts because they are keyed by host path + address.
- One 90-day reuse constant lives in shared code and drives both the shared estimate and the purchase page's own-quote reuse; the 30-day "prices may have changed" label is a separate, older rule.
- The live-quote-click team alert must never block or error for the user: consent skip → team email (no retry); missing key/failure → one retry then team email. **Why:** consent skips silently dropped alerts in production.
- No timing promises in quote copy ("minutes", "seconds", elapsed counters). User asked for this explicitly.
