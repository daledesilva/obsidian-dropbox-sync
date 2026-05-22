# Sync Practices

This document captures the sync design practices discussed for Vaultbox, with focus on safety, correctness, and performance.

## 1. Conservative Conflict Handling

Vaultbox favors fail-safe behavior over aggressive auto-resolution.

Practices:
- Plan-first execution: detect risky states before applying writes.
- Block-on-conflict: if conflicts are detected, do not continue with best-guess mutations.
- Guarded remote writes: use revision-aware updates to prevent silent overwrite.
- Revalidate-before-write: verify local and remote state immediately before upload, download, or delete.
- Preserve partial progress safely: on execution failure, keep valid partial state instead of pretending the full run succeeded.

Why this helps:
- Prevents data loss in stale-state and race-condition scenarios.
- Makes user-visible behavior predictable.
- Reduces accidental overwrite from cross-device edits.

## 2. Cursor-Driven Incremental Remote Detection

Cursor-driven detection means syncing by deltas, not full rescans, after the initial baseline.

Pattern:
1. First sync does a full remote listing and stores a cursor.
2. Later syncs call Dropbox list_folder continue using the stored cursor.
3. Dropbox returns only changes since the last cursor: added, modified, or deleted entries.
4. Client applies those deltas to remote snapshot state and stores the new cursor.

Why this helps:
- Faster repeated sync cycles.
- Lower API volume.
- Better battery and network efficiency on mobile.

Implementation notes:
- Keep a safe fallback path when cursor is invalid or reset is required.
- Treat cursor update and state update as one durable step to avoid drift.

## 3. Longpoll for Low-Latency Change Detection

Longpoll is a wait-for-change API pattern.

Pattern:
1. Client sends request with current cursor.
2. Server holds request open for a short window.
3. If changes happen, server responds immediately.
4. If nothing changes, server responds on timeout.
5. Client repeats.

In Dropbox architecture:
- Longpoll signals that changes exist.
- Cursor-based delta fetch retrieves the actual changed entries.

Why this helps:
- Better responsiveness than periodic fixed-interval polling.
- Lower background churn than frequent polling loops.

## 4. Upload Sessions for Large Files and High-Write Runs

Single-call upload is simple but less suitable for large payloads and heavy write pressure.

Recommended practices:
- Strategy selection by file size:
  - single upload for small files
  - upload_session start append finish for larger files
- Adaptive fallback:
  - on payload_too_large from single upload, retry once via upload session
- Throttling-aware retries:
  - honor Retry-After for 429 cases such as too_many_write_operations and too_many_requests
- Preserve guarded semantics:
  - new file uses add with strict conflict
  - update uses update with prior revision and strict conflict

Optional later optimization:
- finish_batch for many uploads in one sync run, with polling for async completion.

## 5. Why This Is Not Multiplayer Editing

These practices improve sync quality, but they do not provide true multi-cursor real-time collaboration.

Not provided by file-sync architecture:
- Character-level operation merging.
- Presence and live cursor sharing.
- Conflict-free real-time editing semantics.

What would be required for multiplayer:
- Operation-based protocol, typically OT or CRDT.
- Session and presence layer.
- Different conflict model than file-level revision guards.

## 6. Practical Rollout Order

1. Keep conservative conflict protections as non-negotiable safety baseline.
2. Add upload-session strategy and fallback for large-file correctness and throughput.
3. Add cursor-driven incremental remote detection for repeated-sync speed.
4. Add longpoll trigger path for low-latency updates.
5. Consider batch commit only after per-file session path is stable.

## 7. Validation Checklist

- Conflict plan blocks destructive execution.
- Revision-guarded updates reject stale writes.
- Pre-write revalidation catches local and remote races.
- Cursor path handles reset and recovery safely.
- Longpoll path degrades safely to normal scheduled sync.
- Mixed small and large file runs complete correctly.
- Existing regression and correctness tests remain green.
