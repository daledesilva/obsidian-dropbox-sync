#!/usr/bin/env node
/**
 * Generates the Dropbox Sync QA vault.
 *
 * Default target is this directory (`qa-test-vault/`), matching obsidian_ink /
 * obsidian_project-browser so `obsidian-launcher` can open it in-repo. Override
 * with SYNC_TESTER_VAULT (e.g. ~/Documents/sync-tester for system Obsidian).
 *
 * Default (qa:generate / qa:reset): rebuilds START_HERE.md / README.md, _runbooks/,
 * _seeds/, and selected .obsidian config. Never deletes plugins/dropbox-sync/
 * build artifacts or data.json (auth and settings must survive reset).
 *
 * Wipe (qa:restart / --wipe / QA_WIPE=1): erase vault contents (including auth
 * and sync state), then recreate seeds. Does not touch Dropbox remote.
 *
 * Run: bun run qa:generate  |  node qa-test-vault/generate.mjs [--wipe]
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
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(__dirname, "templates");
/** In-repo vault root — also holds generate.mjs / templates (tracked). */
const DEFAULT_VAULT = __dirname;
const VAULT_ROOT = resolve(
  process.env.SYNC_TESTER_VAULT ? process.env.SYNC_TESTER_VAULT : DEFAULT_VAULT,
);
/** When generating into the tooling folder, do not clobber the tracked README. */
const IS_IN_REPO_VAULT = resolve(VAULT_ROOT) === resolve(__dirname);
/** Full erase before regenerate — used by `bun run qa:restart`. */
const WIPE_VAULT =
  process.env.QA_WIPE === "1"
  || process.argv.includes("--wipe");

/** Tracked harness files that must survive an in-repo wipe. */
const IN_REPO_KEEP = new Set([
  "generate.mjs",
  "README.md",
  "SIMULATION_COVERAGE.md",
  "templates",
]);

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

/**
 * Erase the vault so the next generate is a true first-run (new OAuth, empty
 * sync state). In-repo: keep tracked harness files. External SYNC_TESTER_VAULT:
 * delete everything inside the vault root.
 */
async function wipeVaultContents() {
  const home = resolve(homedir());
  const root = resolve(VAULT_ROOT);
  if (
    root === "/"
    || root === home
    || root === resolve(home, "Documents")
    || root === resolve(home, "Desktop")
  ) {
    throw new Error(`Refusing to wipe dangerous path: ${root}`);
  }
  if (!(await pathExists(root))) {
    console.log(`Wipe: ${root} does not exist yet — nothing to erase`);
    return;
  }

  console.log(`Wiping QA vault → ${root}`);
  const entries = await readdir(root);
  for (const name of entries) {
    if (IS_IN_REPO_VAULT && IN_REPO_KEEP.has(name)) continue;
    await rm(join(root, name), { recursive: true, force: true });
  }
  console.log(
    IS_IN_REPO_VAULT
      ? "  erased vault content (kept generate.mjs, README, SIMULATION_COVERAGE, templates/)"
      : "  erased all vault content",
  );
  console.log("  Dropbox remote was not touched — clear it manually if you need a clean peer");
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

  // Ensure plugin folder exists so qa:deploy / launcher have a destination.
  // Never overwrite existing data.json (auth). On a brand-new vault, seed
  // excludes so in-repo harness files (templates/, generate.mjs) do not sync.
  const pluginDir = join(VAULT_ROOT, ".obsidian", "plugins", "dropbox-sync");
  await ensureDir(pluginDir);
  const dataJson = join(pluginDir, "data.json");
  if (IS_IN_REPO_VAULT && !(await pathExists(dataJson))) {
    await writeFile(
      dataJson,
      JSON.stringify(
        {
          excludePatterns: [
            "templates/",
            "generate.mjs",
            "SIMULATION_COVERAGE.md",
            "README.md",
          ],
          onboardingDone: true,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }
}

async function main() {
  if (WIPE_VAULT) {
    await wipeVaultContents();
  }

  console.log(`Generating sync QA vault → ${VAULT_ROOT}`);
  await ensureDir(VAULT_ROOT);

  await wipeOwnedTree("_runbooks");
  await wipeOwnedTree("_seeds");

  // In-repo: keep qa-test-vault/README.md as tooling docs; vault intro is START_HERE.md.
  // External (e.g. ~/Documents/sync-tester): write README.md as the vault landing note.
  await copyFile(
    join(TEMPLATES, "VAULT_README.md"),
    join(VAULT_ROOT, IS_IN_REPO_VAULT ? "START_HERE.md" : "README.md"),
  );
  await copyRunbooks();
  await writeSeeds();
  await writeObsidianConfig();

  console.log("Done.");
  console.log("  _runbooks/  — scenario scripts (see INDEX.md)");
  console.log("  _seeds/     — baseline notes, case, folders, binaries, bulk, exclude-bait");
  if (WIPE_VAULT) {
    console.log("  wiped — expect fresh OAuth / empty sync state on next open");
  } else {
    const dataJson = join(
      VAULT_ROOT,
      ".obsidian",
      "plugins",
      "dropbox-sync",
      "data.json",
    );
    console.log(
      (await pathExists(dataJson))
        ? "  plugin data.json left in place (qa:reset does not erase auth)"
        : "  no plugin data.json yet — OAuth once after bun run qa:open",
    );
  }
  console.log("");
  console.log("Next:");
  console.log("  bun run qa:open / qa:restart — generate (+ wipe) + sandboxed Obsidian");
  console.log(`  Vault: ${VAULT_ROOT}`);
  console.log("  Sync Now once, then open _runbooks/INDEX.md");
  console.log("");
  console.log(
    WIPE_VAULT
      ? "Warning: local vault was erased; Dropbox remote was not. Wipe the linked folder if you need a clean peer."
      : "Warning: qa:reset reseeds local files only. Use qa:restart to erase auth/state. Wipe Dropbox after dirty scenarios.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
