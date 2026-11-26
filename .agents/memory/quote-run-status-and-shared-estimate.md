---
name: Quote run status, answer autosave, shared live-quote estimate
description: Decisions for persisted live-quote run status, server-side insurance answer merging, and reusing recent live quotes as general estimates.
---

- Run status is derived, not stored: saved-results pending marker + this user's own cache rows (owner or email user). Running = marker newer than last result and younger than 12 min poll window + 3 min grace. A success with 0 quotes = agent follow-up.
  **Why:** user preferred no schema change. **How to apply:** any new terminal path in the worker must clear the pending marker, or the UI shows "running" until grace expires.
- Insurance answer autosave goes through a server merge endpoint, never the full-list rewrite (which deletes rows not in memory). live_quote_* keys are server-owned and never accepted from the client.
  **Why:** multi-device edits must not clobber each other or the live-quote mirror.
- Shared estimate: number + date only, 90 days, any user. HO3/HO6 need exact occupancy match; investment never gets primary quotes (HO3+investment reads DP3). Manual premium, simulator edits, and the user's own quote win.
- The estimate page stamps annual_ho_ins = "recent_live_quote" when using a shared number so reload doesn't auto-stamp it as manual.
