# Privacy and compliance batch

Built on PR #8, not on an independent rewrite. No property-tax, insurance
premium or flood calculation changes. Do not publish without approval.

## Implemented
- Private durable Supabase leads, explicit unverified-phone saves when Twilio
  is absent, cryptographic OTP generation/hashes with expiry and five attempts.
- Admin session/email allowlist on lead listing and diagnostic endpoints;
  FUB test endpoint disabled in production; Zillow key endpoint returns 404.
- No API response-body logging. Helmet, same-origin API restrictions, IP and
  verified-user throttling for lead, quote, scraping and AI entry points.
- Private property-cache access, seven-day price-data expiry.
- Optional unchecked marketing consent on registration and lead dialog;
  wording/version, timestamp, IP, user agent and choice retained privately.
  CRM contact workflows check stored consent and fail closed.
- Havo provider/brand/social cleanup; insurance Tateo & Co attribution and
  license disclosures preserved.
- Removed the injected CRM contact/tracking widget, which displayed the old
  general Tateo branding and bypassed Havo's consent-recorded forms. Existing
  CRM records were not deleted; site phone/email links remain.
- HUD Equal Housing Opportunity logo from
  https://www.hud.gov/sites/dfiles/FHEO/images/fheo100.gif
  (converted to PNG), lender disclosures in result/worksheet and PDF footer.
- DTI-only badge disclaimer; qualification requires confirmed inputs.
- Original credit-score-only PMI factors restored unchanged at the user's request;
  the illustrative LTV table was removed. Matched-remaining-term refi comparison retained.
- Cost-tool Open Graph graphic, zoom, homepage input label, sitemap/404 and
  eight-character password validation in application forms.

## Already present
- APR beside displayed estimate/worksheet rates.
- Refinance current-payment calculation already uses remaining term; the
  new matched-term display supplements the separately labeled 30-year option.
- Root file `Adding to Tateo & Co` was absent.

## Verification
- TypeScript and production build passed.
- 506 unit tests passed.
- 26 existing browser tests passed; two new privacy tests passed after fixing
  wildcard-route HTTP status handling and the combobox selector.
- The 3102 W Nassau St result journey was exercised again with runtime-error
  and HTTP-failure listeners: no errors reproduced; DTI disclaimer visible.
- New Supabase tables and row-level security confirmed after migration.

## External settings / limitations
- Google Maps HTTP-referrer restrictions must be verified/applied in Google
  Cloud; no authorized Google Cloud configuration connection is available.
- Supabase Auth provider-level password policy is explicitly out of scope at
  the user's request; no provider change is needed. Application form validation
  remains unchanged.
- OTP/rate-limit stores are per process. A restart invalidates outstanding
  OTPs safely, and multi-instance limits are not globally coordinated.
- Consent controls new application CRM dispatches; existing FUB campaigns
  and manual calling lists need a separate consent/suppression audit.
- The shared Supabase migration was applied immediately; no website publish
  was performed. Existing lead data was not deleted.
