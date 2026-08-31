# Performance and scale verification

Star Companion uses deterministic, synthetic datasets for performance work. Every benchmark creates a uniquely named database and media directory under the operating-system temporary directory, writes a `.star-companion-perf` ownership marker, and refuses to clean any directory without that marker. The scripts never point at `apps/server/prisma/dev.db` or a user data directory.

## Dataset profiles

| Profile | Characters | Chats | Messages | Long chat | Memories | Media assets | Attachments |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Small | 20 | 50 | 2,000 | 500 | 200 | 20 | 40 |
| Medium | 200 | 1,000 | 25,000 | 5,000 | 2,000 | 500 | 1,000 |
| Large | 1,000 | 5,000 | 200,000 | 20,000 | 10,000 | 1,000 | 5,000 |
| Mobile-large | 300 | 1,500 | 60,000 | 10,000 | 3,000 | 250 | 1,500 |

The fixed seed is `20260831`. Fixtures cover active, pinned, archived, checkpoint, foldered and trashed chats; context exclusions; bookmarks; variants; incomplete generation metadata; memory states; and deduplicated attachment references. They contain no API key, real conversation, persona, profile summary, or user image.

## Commands

```bash
# Validate exact counts, references, and important query plans.
npm run perf:regression

# Server API timings, query counts, query plans, and process memory.
npm run perf:server -- --profile large --samples 12

# Browser cold navigation, bounded timeline DOM, anchors, requests, long tasks, and heap.
npm run perf:web -- --profile large --pages 100

# Embedded mobile-backend timings and process memory.
npm run perf:mobile -- --profile mobile-large --samples 12

# Destructive-flow evidence on a temporary Large or Mobile-large database.
npm run perf:server -- --profile large --samples 5 --bulk true
npm run perf:mobile -- --profile mobile-large --samples 5 --bulk true

# Combine JSON results into perf-results/report.md.
npm run perf:report

# Compare like-for-like results and fail above a percentage regression threshold.
npm run perf:compare -- --baseline perf-results/baseline.json --current perf-results/current.json --threshold 20
```

`perf:seed` can create a named fixture only when explicit temporary database and media paths are supplied. JSON, Markdown, CPU profiles, and heap snapshots under `perf-results/` are intentionally ignored by Git because they include machine-specific measurements.

## What is bounded

- Message timelines load the latest 50 records and retain at most 250 rendered message containers. Older pages use a strict `(createdAt, id)` cursor and preserve the visible anchor.
- Chat history, message search, bookmarks, characters, and long-term memories use bounded pages. A cursor is scoped to its exact operation and filter; a cursor from another request is rejected.
- The Prompt builder reads only the configured recent context window. Desktop and mobile use the same role and ordering semantics.
- Semantic memory recall scans bounded keyword and vector candidate sets. A forced vector rebuild runs in batches of 64, commits each completed batch in a short transaction, reports counts without content, and can be cancelled. Keyword recall remains available.
- Timeline images request validated, access-controlled thumbnails and load lazily; the original asset is fetched only for the full preview. Thumbnail memory caches are bounded and cleared by the privacy lock.
- Usage summaries aggregate in SQLite and fetch only the 30 most recent attempts instead of materializing the complete ledger in the server process.

## Reading a result

Compare only reports with the same runtime kind, dataset profile, app/schema version, hardware, Node/browser version, sample count, and warm/cold mode. Use p95 for route regressions, but retain p50 and maximum to distinguish sustained changes from one outlier. Query count growth is treated as an N+1 regression even when a small fixture still looks fast.

For the browser report, success also requires no message-anchor violation, at most 50 initial message containers, and at most 250 steady-state message containers. For mobile, WASM SQLite keeps the database in process memory, so RSS is expected to include the database image; compare RSS only between the same profile and runtime.

## Observed baseline

| Date | Commit | Runtime/profile | Environment | Samples/pages | Key p95 results | Peak memory | Result/notes |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 2026-08-31 | `61297eb` + working tree | server Large | Windows x64 / i5-13490F / Node 24.10 / SQLite 3.50 | 12 | latest 26.18 ms; older 66.43 ms; chats 71.69 ms; pathological 187,667-hit global search 2,162.77 ms; Prompt 40.57 ms | RSS 175.8 MB / heap 56.2 MB | exact search total and fixed query counts validated |
| 2026-08-31 | `61297eb` + working tree | web Large | Chromium 148 / 1440×900 | 100 pages | interactive 946.96 ms; max long task 300 ms | heap 18.4 MB | anchors 0; initial DOM 50; steady DOM 250 |
| 2026-08-31 | `61297eb` + working tree | mobile Mobile-large | Windows x64 / i5-13490F / Node 24.10 | 12 | latest 19.31 ms; older 18.36 ms; search 95.46 ms; Prompt 126.98 ms | RSS 382.4 MB / heap 37.2 MB | WASM database is included in RSS |

The compatible pre-change server Large result at `b5d86de` loaded all 20,000 long-chat messages and all 5,000 chats: their p95 values were 1,045.06 ms and 2,539.08 ms. The bounded result improves those paths by 97.49% and 97.18%, global search by 79.84%, RSS by 87.03%, and heap by 91.32%. Prompt p95 increased from 10.04 ms to 40.57 ms because the current contract performs bounded keyword/semantic memory candidates and attachment-aware context reads; this is a measured absolute sub-50-ms tradeoff, not an unreported pass under the 20% comparison threshold.

## Large destructive-flow evidence

The 2026-08-31 server Large run exported a 156,086,429-byte schemaVersion 1 envelope containing 200,000 messages, previewed replace in 81.53 s, executed it in 261.43 s with an automatic recovery point, and restored that point in 446.22 s with a pre-restore safety point. The exact 20,000-message long chat was present afterward. Peak RSS was 2.40 GB and peak heap was 2.09 GB, so this validates correctness and bounded HTTP acceptance rather than claiming low-memory streaming. The matching Mobile-large run used a 30,330,004-byte envelope with 60,000 messages: preview 8.85 s, replace 16.03 s, restore 16.10 s, and both recovery points present; peak RSS was 1.13 GB including the WASM database.

Backup and sync JSON requests are capped at 256 MB. Desktop/mobile peer export and preview allow up to three minutes, while execute allows up to ten minutes. Payload schema, media limits, free-space checks, transaction boundaries, conflict preview, and recovery points remain authoritative; the larger parser limit is not permission to bypass them.

Do not publish a benchmark as a universal latency guarantee. Preserve the raw JSON when investigating a regression, record the exact failed command, and distinguish a code regression from a machine or browser change.
