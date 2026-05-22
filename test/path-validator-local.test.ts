import { describe, test, expect } from "bun:test";
import {
  getLocalPathIssues,
  getPathIssues,
  isPathValid,
  suggestFixedPath,
} from "@/sync/path-validator";

describe("getLocalPathIssues", () => {
  test("colon in filename → local issue", () => {
    const issues = getLocalPathIssues("notes/file:name.md");
    expect(issues.some((i) => i.code === "forbidden_char")).toBe(true);
  });

  test("reserved name CON → local issue", () => {
    const issues = getLocalPathIssues("CON.md");
    expect(issues.some((i) => i.code === "reserved_name")).toBe(true);
  });

  test("normal path → no issues", () => {
    expect(getLocalPathIssues("notes/hello.md")).toHaveLength(0);
  });
});

describe("suggestFixedPath", () => {
  test("replaces colon with dash", () => {
    expect(suggestFixedPath("file:name.md")).toBe("file-name.md");
  });

  test("fixes reserved name", () => {
    expect(suggestFixedPath("CON.md").toLowerCase()).toBe("_con.md");
  });

  test("trims trailing space in segment", () => {
    expect(suggestFixedPath("notes /file.md")).toBe("notes/file.md");
  });
});

describe("getPathIssues strictLocal", () => {
  test("strictLocal includes dropbox and local", () => {
    const issues = getPathIssues("file:name.md", true);
    expect(issues.some((i) => i.rule === "local")).toBe(true);
  });

  test("non-strict only dropbox rules", () => {
    expect(getPathIssues("file:name.md", false).some((i) => i.rule === "local")).toBe(false);
    expect(isPathValid("file:name.md", false)).toBe(true);
  });
});
