/**
 * Ensures every sync rule R1–R14 has at least one call site that tags it.
 * Without this, a rule can silently stop being logged when a refactor moves
 * the decision, and "validate every rule from logs" becomes aspirational.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALL_SYNC_RULE_IDS_R_ONLY, SyncRules } from "@/debug/sync-monitor";

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      out.push(...collectSourceFiles(path));
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

describe("sync log taxonomy", () => {
  test("every R1–R14 rule has a SyncRules.* call site in src/", () => {
    const srcRoot = join(import.meta.dir, "../src");
    const sources = collectSourceFiles(srcRoot)
      // The constant definitions themselves do not count as usage.
      .filter((path) => !path.endsWith("/debug/sync-monitor.ts"));
    const corpus = sources.map((path) => readFileSync(path, "utf8")).join("\n");

    const missing: string[] = [];
    for (const ruleId of ALL_SYNC_RULE_IDS_R_ONLY) {
      // Accept SyncRules.R2 or ruleId: "R2" / ruleId: SyncRules.R2 string form.
      const byConst = corpus.includes(`SyncRules.${ruleId}`);
      const byString = new RegExp(`ruleId:\\s*"${ruleId}"`).test(corpus)
        || new RegExp(`ruleId:\\s*'${ruleId}'`).test(corpus);
      if (!byConst && !byString) {
        missing.push(ruleId);
      }
    }

    expect(missing).toEqual([]);
  });

  test("SyncRules exposes R1 through R14 without gaps", () => {
    for (let i = 1; i <= 14; i++) {
      const id = `R${i}` as (typeof ALL_SYNC_RULE_IDS_R_ONLY)[number];
      expect(SyncRules[id]).toBe(id);
    }
    expect(ALL_SYNC_RULE_IDS_R_ONLY).toHaveLength(14);
  });
});
