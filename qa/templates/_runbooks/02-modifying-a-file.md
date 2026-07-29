# 02 — Modifying a file

## Setup

1. Sync Now so `_seeds/notes/baseline.md` matches Dropbox.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).

---

## Pass 1 — A (one Sync Now)

### A — Local modify

1. Edit `_seeds/notes/baseline.md` — append one unique line (include a timestamp).

### Sync and validate (Pass 1)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **A:** Upload for `_seeds/notes/baseline.md`; Dropbox shows the new line; no conflict copy.

---

## Pass 2 — B (one Sync Now)

### B — Second local modify

1. Edit `_seeds/notes/baseline.md` again — append a second unique line.

### Sync and validate (Pass 2)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **B:** Upload again; Dropbox holds both appended lines; still no conflict copy.

---

## Pass 3 — C (one Sync Now)

### C — Identical re-save

1. Re-save `_seeds/notes/baseline.md` without changing bytes (touch/save only).

### Sync and validate (Pass 3)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **C:** Noop / no re-upload of identical content; no conflict copy.
