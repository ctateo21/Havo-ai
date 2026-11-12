# AI model benchmark

## Safety and reproducibility

Run `npx tsx scripts/benchmark-ai.ts anthropic/claude-opus-4.5` and repeat for
`anthropic/claude-sonnet-4.5` and `anthropic/claude-haiku-4.5`.
These are paid, opt-in runs; they are deliberately not part of CI.
The harness sets model overrides only in its own process, never shared or
production configuration. No borrower records, saved listings, database writes,
third-party OCR, or alternative provider routing are involved.

The harness uses the production extraction functions, market prompt, and
OpenRouter adapter. Synthetic PDFs use vector checkbox marks (not text
substitutes) and native PDF parsing. The request retains Anthropic-only routing,
disabled fallback, and denied provider data collection.

Outputs are saved under the ignored `generated-artifacts/ai-benchmark/`
directory. They include synthetic responses, per-field comparisons, actual
OpenRouter `usage.cost`, response status, tokens, and wall-clock latency.
Cost is provider-reported, not a price-list estimate. Missing billing data must
not be treated as zero. A subsequent run overwrites that model's result file.
Permission, billing, and rate-limit errors stop a model's run.

## Acceptance criteria

Before any default-model change:

- All critical fixture fields must match exactly, on both repetitions; no
  regression against Opus is acceptable.
- Native Conventional/FHA/VA and Other checkboxes must be distinguished.
- Leading-zero/dashed loan IDs, distracting account IDs, dates, note terms,
  payment amounts, monthly escrow versus initial/current escrow, and absent
  current escrow balance must be correct.
- An invalid zero-amount Closing Disclosure must be rejected by the existing
  production validation, not accepted as a usable loan.
- Seller recaps must preserve supplied DOM/views/saves and leave unprovided
  private engagement counts null.
- Market responses must retain real URL annotations from native web research;
  model-written source names alone do not pass.
- All compared calls must have recorded billing and successful completion.
  Candidate cost must be lower for the same passing workload.

Passing this small synthetic suite is a screening result, not proof of accuracy
on scanned, low-resolution, lender-specific, or ambiguous five-page forms.
Those need expanded regression coverage; the measured acceptance here is
limited to the synthetic fixtures above. Citation presence also does not establish that every financial or
market claim is supported by its source.

## Live results

Run date: 2026-10-13. An Anthropic-only Opus preflight succeeded (HTTP 200,
1.259 s, $0.000180); the previously reported credit restriction did not recur.
No billing configuration or credentials were changed.

### Documents

Each model ran the identical 14-call workload: four checkbox variants, one
invalid-zero-amount CD, and two mortgage statements (present/absent current
escrow balance), each repeated twice. This is eight distinct synthetic cases
including the market case, not a large independent sample of real documents.

| Model | Passing document calls | Exact field checks | Total billed USD | Mean latency |
| --- | ---: | ---: | ---: | ---: |
| Opus 4.5 | 14/14 | 116/116 | 0.332590 | 4.085 s |
| Sonnet 4.5 | 14/14 | 116/116 | 0.203304 | 7.216 s |
| Haiku 4.5 | 14/14 | 116/116 | 0.066173 | 3.760 s |

The remaining two calls per model are rejection tests, both passing. All calls
had provider-reported billing; no missing usage was counted as zero.
Haiku cost **80.10% less** than Opus on this workload, with no measured critical
field regression. Sonnet cost 38.87% less but was slower in this run.
These are small-sample wall-clock observations, not production latency SLAs.

**Decision:** select Haiku 4.5 as the document default only. Keep native PDF
handling, strict existing CD validation, and the Anthropic-only provider policy
unchanged. Explicit `OPENROUTER_DOCUMENT_MODEL` overrides still take precedence;
setting it to `anthropic/claude-opus-4.5` restores the former model without a
code change. No environment overrides were present during inspection.

### Seller recaps

| Model | Passing recap calls | Total billed USD | Mean latency |
| --- | ---: | ---: | ---: |
| Opus 4.5 | 0/2 | 0.891385 | 50.151 s |
| Sonnet 4.5 | 0/2 | 0.440671 | 70.284 s |
| Haiku 4.5 | 0/2 | 0.103707 | 26.465 s |

All six returned HTTP 200 with billing data. Opus and Haiku each had one
parseable response without citation annotations and one non-JSON response;
both Sonnet responses were non-JSON. Failed recap costs are not counted as
acceptable savings. Total provider-reported cost for all 48 benchmark calls
and the billing preflight was **$2.038010**.

Do not downgrade the market default. The initial live responses failed the
acceptance gate even on Opus: JSON-only responses lacked returned URL
annotations, while other responses contained research narration rather than
a single JSON object. The annotation extraction unit test still passes,
distinguishing a live research/response problem from simply dropping known
annotations in the adapter.

The synthetic listing supplied price, size, DOM, views, and saves; only public
Tampa market context was eligible for research. Passing parsed responses kept
those supplied values and left private Realtor/Redfin engagement null, but
that alone is insufficient to accept the recap.

**Decision:** retain Opus 4.5 for market research. Treat its baseline failures
as a reliability finding, not permission to relax citation/structured-output
requirements for a cheaper model. No claim is made that the retained baseline
passed this live gate. The benchmark does not modify the existing cache or
production failure handling.

### Local verification

`npm run check` and the ten tests in `server/openrouter.test.ts` pass. The latter
also checks independent invalid-address, loan-amount, interest-rate, term, and
closing-date rejection, safe errors, complete responses, native PDF requests,
market citation filtering, model-family restrictions, and the explicit Opus
override. The application restarted and its public landing page rendered.
