import { LocalPathError, PathValidationError } from "../types";
import { getPathIssues, summarizePathIssues } from "./path-validator";

export function assertValidSyncPath(path: string, strictLocal: boolean): void {
  const issues = getPathIssues(path, strictLocal);
  if (issues.length === 0) return;

  const summary = summarizePathIssues(issues);
  const hasLocal = issues.some((i) => i.rule === "local");
  const hasDropbox = issues.some((i) => i.rule === "dropbox");

  if (hasLocal && strictLocal) {
    throw new LocalPathError(path, summary);
  }
  if (hasDropbox) {
    throw new PathValidationError(path, summary);
  }
  if (hasLocal) {
    throw new LocalPathError(path, summary);
  }
}
