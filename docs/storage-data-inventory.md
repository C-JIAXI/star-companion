# Local storage and data-health inventory

This inventory is the implementation boundary for Settings → Storage & health. It covers application-owned data only. APIs return category names, counts, sizes, measurement quality, and safe issue codes; they never return full local paths, full media hashes, API keys, chat text, personas, or profile summaries.

| Category | Desktop / server location | Mobile location | References | Retention / cleanup | Rebuildable | Main risk |
| --- | --- | --- | --- | --- | --- | --- |
| SQLite allocation | App-private `star-companion.db`; isolated Prisma DB in development | App-private `mobile-backend.sqlite` | All records | Never deleted; optional standalone `VACUUM` when supported | No | Corruption, low disk, interrupted write |
| Characters, chats, messages, non-key settings | Typed SQLite tables | SQLite `records` | Character → chat → message; settings singleton | User lifecycle, backup/import and trash rules | No | Missing references, incompatible schema |
| Current memories | `ChatMemory` | `memory` | Chat and optional source-message IDs | Tombstone/purge rules | No | Dangling references |
| Memory revisions | `MemoryRevision` | `memoryRevision` | Memory, chat, optional operation | Maximum 30 per memory | No | Non-monotonic pointer |
| Memory operations | `MemoryOperation` | `memoryOperation` | Chat and revision batch | Maximum 100 per chat | No | Stale operation state |
| Profile revisions | `ProfileSummaryRevision` | `profileSummaryRevision` | Chat and optional message sources | Existing history rules | No | Pointer mismatch, sensitive text |
| Chat media bytes | `MediaAsset.data` BLOB | `mediaAsset.dataBase64` in app-private SQLite | Attachments and recovery references | Delete only with zero references | No | Hash/length/MIME/dimension/decode mismatch |
| Sent media references | `MessageAttachment.messageId` | Same logical record | Message and asset | Message timeline lifecycle | No | Broken/double-owned reference |
| Draft media references | `MessageAttachment.draftId` | Same logical record | Controlled draft ID and asset | Expire after 24 hours | No | Abandoned large draft |
| Protected composer drafts | `ChatDraft`; `MessageAttachment.composerChatId` ownership | `chatDraft` record and composer-owned attachments | Chat and ordered metadata-only manifest | Text until explicit clearing/chat permanent deletion; images expire 24 hours after upload, reads do not renew; unavailable placeholders remain | No | Concurrent writes, missing/expired images, unacknowledged saves |
| Pending sends / queue snapshots and receipts | `DraftHandoff`; `MessageAttachment.handoffId` | `draftHandoff` and owned attachment records | Chat, immutable snapshot, committed message ID | At most 100 pending snapshots per chat; manual restore/discard; committed/disposed receipts contain no text or images and persist until chat deletion to prevent duplicate sends after ledger/message pruning | No | Lost acknowledgement, wrong composer version, duplicate send |
| Recovery media references | `RecoveryPointMediaAsset` | Same logical record | Recovery point and asset | Recovery retention | No | Deleting recoverable media |
| Character images | `Character.avatar` data URLs; HTTPS is remote | Same | Character | Character lifecycle | No | Encoded size miscount |
| Persona images | Chat avatar and persona-preset data URLs | Same | Chat/preset | Owning record lifecycle | No | Sensitive association |
| Chat backgrounds | Chat background data URLs; HTTPS is remote | Same | Chat | Chat lifecycle | No | Encoded size miscount |
| Embeddings / indexes | Memory embedding fields | Memory record fields | Current memory and embedding identity | User-selected clear marks stale; existing indexing rebuilds | Yes | Invalid values/dimensions |
| Recovery points | `RecoveryPoint` and media references | Recovery records and references | Snapshot and assets | Maximum 10 and 30 days | No | Damaged snapshot, unbounded growth |
| Upgrade-recovery copies | App-private `upgrade-recovery` manifest/DB pairs | Migration layer managed; cleanup unavailable | Valid manifest names paired DB | Keep newest 5 valid pairs; anomalies retained | No | Traversal/link/incomplete pair |
| Trash and tombstones | Chat/memory `deletedAt` | Same | Existing records | User-confirmed permanent purge only | No | Accidental loss |
| Usage ledger | `ModelRequest`, `ModelUsageAttempt` | Request/attempt records | Optional chat/message | Terminal history only; active reservations retained | No | Active reservation deletion, association leak |
| App temp/cache | Exact app-private `temp` and `cache` children | Same | None | Per-action regular-file cleanup | Yes | Link traversal, unrelated files |
| Other private files | Non-recursive root summary excluding active DB/sidecars | Unavailable if unsafe to classify | Runtime-specific | Never auto-deleted | Depends | Misclassification |
| Exports | User-selected download; not enumerated | Private staging before Android share | User export action | User-managed, excluded from cleanup | No | Treating exports as cache |

## Measurement and safety rules

- Composer drafts, pending sends and receipts are device-local and excluded from full backups, recovery points, chat archives, and LAN sync. Replace removes them together with replaced chats; ordinary chat trash retains them and blocks sending. Live `MessageAttachment` rows (including composer and handoff ownership) protect assets from orphan cleanup. Removing an expired reference never deletes assets shared with a sent message, another live draft, or recovery point. Draft manifests contain no image bytes. The `chat_drafts` category counts drafts/receipts and estimates UTF-8 text plus metadata-manifest bytes using SQLite aggregates; it is not physical SQLite allocation. The UI supports recovery and explicit conflicts; remaining verification is recorded in `chat-drafts-implementation.md`.

- `exact` means filesystem allocation, stored media byte length, or a direct reference count.
- `estimated` means UTF-8/JSON logical size or decoded data-URL size, not physical SQLite allocation.
- `unavailable` means the backend cannot measure safely or consistently on that platform.
- HTTPS images are remote and contribute no claimed local image bytes.
- Cleanup accepts action enums only, never a client path. It derives allow-listed app-private directories, checks canonical containment, reads non-recursively, and refuses links/reparse entries, directories, malformed upgrade manifests, unexpected names, and changed targets. Anomalies stay untouched and produce count-only issues.
- One deep scan or maintenance execution runs at a time. Plans expire after five minutes, are one-use, and fail if targets changed. Privacy lock returns `423` and cancels active deep scans. Checks never repair or delete. Each cleanup action reports completed, skipped, or failed independently.
