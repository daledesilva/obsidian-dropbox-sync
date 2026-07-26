#!/usr/bin/env node
/**
 * Generates the Dropbox Sync QA vault into ~/Documents/sync-tester (or SYNC_TESTER_VAULT).
 *
 * Idempotent for content it owns: rebuilds README, _runbooks/, _seeds/, and selected
 * .obsidian config. Never deletes plugins/dropbox-sync/ build artifacts or data.json
 * (auth and settings must survive reset).
 *
 * Run: bun run qa:generate  |  node qa-test-vault/generate.mjs
 */
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
  access,
} from "fs/promises";
import { constants } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(__dirname, "templates");
const DEFAULT_VAULT = join(homedir(), "Documents", "sync-tester");
const VAULT_ROOT = process.env.SYNC_TESTER_VAULT
  ? process.env.SYNC_TESTER_VAULT
  : DEFAULT_VAULT;

/** Minimal 1×1 PNG (68 bytes). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Minimal valid PDF. */
const TINY_PDF = Buffer.from(
  `%PDF-1.1
1 0 obj<<>>endobj
2 0 obj<< /Length 44 >>stream
BT /F1 12 Tf 100 700 Td (sync-tester) Tj ET
endstream
endobj
3 0 obj<< /Type /Page /Parent 4 0 R /MediaBox [0 0 300 144] /Contents 2 0 R >>endobj
4 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
5 0 obj<< /Type /Catalog /Pages 4 0 R >>endobj
xref
0 6
0000000000 65535 f 
trailer<< /Size 6 /Root 5 0 R >>
startxref
0
%%EOF
`,
  "utf8",
);

const BULK_COUNT = 50;

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function writeText(relPath, content) {
  const full = join(VAULT_ROOT, relPath);
  await ensureDir(dirname(full));
  await writeFile(full, content, "utf8");
}

async function writeBytes(relPath, data) {
  const full = join(VAULT_ROOT, relPath);
  await ensureDir(dirname(full));
  await writeFile(full, data);
}

/**
 * Remove a generated tree, but never touch plugin build/auth under
 * .obsidian/plugins/dropbox-sync/.
 */
async function wipeOwnedTree(relDir) {
  const full = join(VAULT_ROOT, relDir);
  if (await pathExists(full)) {
    await rm(full, { recursive: true, force: true });
  }
}

async function copyRunbooks() {
  const srcDir = join(TEMPLATES, "_runbooks");
  const destDir = join(VAULT_ROOT, "_runbooks");
  await ensureDir(destDir);
  const entries = await readdir(srcDir);
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    await copyFile(join(srcDir, name), join(destDir, name));
  }
}

async function writeSeeds() {
  await writeText(
    "_seeds/notes/baseline.md",
    "# Baseline\n\nSeed note for modify / interrupt runbooks.\n\nDo not delete unless a runbook says so.\n",
  );
  await writeText(
    "_seeds/notes/conflict-target.md",
    "# Conflict target\n\nEdit this on two sides with different content for §3.\n",
  );
  await writeText(
    "_seeds/notes/deletable.md",
    "# Deletable\n\nSafe to delete for §4. Reseed with qa:reset afterward.\n",
  );
  await writeText(
    "_seeds/notes/cross-delete.md",
    "# Cross-delete\n\nFor edit-vs-delete runbooks (§5).\n",
  );
  await writeText(
    "_seeds/notes/rename-me.md",
    "# Rename me\n\nRename to renamed.md for §6.\n",
  );
  await writeText(
    "_seeds/notes/never-saw-delete.md",
    "# Never-saw delete\n\nDelete on Dropbox web for §11 ambiguous-delete checks.\n",
  );

  await writeText(
    "_seeds/case/Note.md",
    "# Case fixture\n\nStarts as Note.md — case-rename to note.md for §7.\n",
  );

  await writeText(
    "_seeds/folders/nested/deep-note.md",
    "# Deep note\n\nNested path for move/rename (§6 / §9).\n",
  );
  await writeText(
    "_seeds/folders/empty-keep/.keep.md",
    "Placeholder so the empty-keep folder exists in git-like seeds. Delete this file to test empty-folder behaviour (§8).\n",
  );

  await writeBytes("_seeds/binaries/empty.txt", Buffer.alloc(0));
  await writeBytes("_seeds/binaries/tiny.png", TINY_PNG);
  await writeBytes("_seeds/binaries/tiny.pdf", TINY_PDF);

  for (let i = 1; i <= BULK_COUNT; i++) {
    const n = String(i).padStart(2, "0");
    await writeText(
      `_seeds/bulk/bulk-${n}.md`,
      `# Bulk ${n}\n\nMass-delete / coalesce fixture (${i}/${BULK_COUNT}).\n`,
    );
  }

  // Paths that look syncable but are intended for exclude-pattern / scope experiments.
  await writeText(
    "_seeds/exclude-bait/README.md",
    "# Exclude bait\n\nAdd device exclude patterns for these paths (or `.obsidian`-style names) when testing P4 scope. Out-of-scope trees must not become silent mass deletes.\n",
  );
  await writeText(
    "_seeds/exclude-bait/should-stay-local.md",
    "Candidate for a device-local exclude pattern during §13.\n",
  );
}

async function writeObsidianConfig() {
  await ensureDir(join(VAULT_ROOT, ".obsidian"));
  // Preserve existing community-plugins entries where possible, but always enable dropbox-sync.
  const communityPath = join(VAULT_ROOT, ".obsidian", "community-plugins.json");
  let plugins = ["dropbox-sync"];
  if (await pathExists(communityPath)) {
    try {
      const existing = JSON.parse(await readFile(communityPath, "utf8"));
      if (Array.isArray(existing)) {
        plugins = [...new Set([...existing, "dropbox-sync", "hot-reload"])];
      }
    } catch {
      plugins = ["dropbox-sync", "hot-reload"];
    }
  } else {
    plugins = ["dropbox-sync", "hot-reload"];
  }
  await writeFile(communityPath, JSON.stringify(plugins, null, 2) + "\n", "utf8");

  const appPath = join(VAULT_ROOT, ".obsidian", "app.json");
  if (!(await pathExists(appPath))) {
    await writeFile(
      appPath,
      JSON.stringify(
        {
          legacyEditor: false,
          livePreview: true,
          showFrontmatter: true,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }

  // Ensure plugin folder exists so qa:deploy has a destination; never touch data.json.
  await ensureDir(join(VAULT_ROOT, ".obsidian", "plugins", "dropbox-sync"));
}

async function main() {
  console.log(`Generating sync QA vault → ${VAULT_ROOT}`);
  await ensureDir(VAULT_ROOT);

  await wipeOwnedTree("_runbooks");
  await wipeOwnedTree("_seeds");

  await copyFile(
    join(TEMPLATES, "VAULT_README.md"),
    join(VAULT_ROOT, "README.md"),
  );
  await copyRunbooks();
  await writeSeeds();
  await writeObsidianConfig();

  const dataJson = join(
    VAULT_ROOT,
    ".obsidian",
    "plugins",
    "dropbox-sync",
    "data.json",
  );
  const hasAuth = await pathExists(dataJson);

  console.log("Done.");
  console.log("  _runbooks/  — scenario scripts (see INDEX.md)");
  console.log("  _seeds/     — baseline notes, case, folders, binaries, bulk, exclude-bait");
  console.log(
    hasAuth
      ? "  plugin data.json preserved (auth intact)"
      : "  no plugin data.json yet — open vault and OAuth once after qa:deploy",
  );
  console.log("");
  console.log("Next:");
  console.log("  1. bun run qa:deploy");
  console.log(`  2. Open ${VAULT_ROOT} in Obsidian`);
  console.log("  3. Sync Now once, then open _runbooks/INDEX.md");
  console.log("  4. For agent-assisted runs: /debug-ingest then enable Debug logging");
  console.log("");
  console.log(
    "Warning: qa:reset reseeds local files only. Wipe the linked Dropbox folder after delete/conflict/casing scenarios.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
