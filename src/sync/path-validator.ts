/**
 * Dropbox 및 로컬(특히 iOS) 경로 검증 + 자동 수정 제안.
 */

/** 금지 문자 (Dropbox API: NUL, 제어문자) */
// eslint-disable-next-line no-control-regex -- 제어문자 감지가 이 함수의 목적
const FORBIDDEN_CHARS = /[\x00-\x1f\x7f]/;

/** Windows / iOS에서 문제되는 경로 문자 (세그먼트 단위) */
const LOCAL_FORBIDDEN_IN_SEGMENT = /[\\/:*?"<>|]/;

const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export type PathRule = "dropbox" | "local";

export interface PathIssue {
  rule: PathRule;
  code: string;
  message: string;
}

/**
 * Dropbox 경로 유효성 검증.
 * 유효하면 null, 위반이면 사유 문자열을 반환한다.
 */
export function validateDropboxPath(path: string): string | null {
  const issues = getDropboxPathIssues(path);
  return issues.length > 0 ? issues[0].message : null;
}

/** Dropbox 규칙 위반 목록 */
export function getDropboxPathIssues(path: string): PathIssue[] {
  const issues: PathIssue[] = [];
  if (!path) {
    issues.push({ rule: "dropbox", code: "empty", message: "path is empty" });
    return issues;
  }

  if (FORBIDDEN_CHARS.test(path)) {
    const match = path.match(FORBIDDEN_CHARS)!;
    issues.push({
      rule: "dropbox",
      code: "forbidden_control_char",
      message: `forbidden character: '${match[0]}'`,
    });
  }

  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "") continue;

    if (seg === "." || seg === "..") {
      issues.push({
        rule: "dropbox",
        code: "invalid_segment",
        message: `invalid segment: '${seg}'`,
      });
    }

    if (seg.endsWith(" ") || seg.endsWith(".")) {
      issues.push({
        rule: "dropbox",
        code: "segment_trailing_char",
        message: `segment ends with '${seg[seg.length - 1]}': '${seg}'`,
      });
    }
  }

  return issues;
}

/** 로컬(iOS/모바일) 파일시스템 규칙 위반 목록 */
export function getLocalPathIssues(path: string): PathIssue[] {
  const issues: PathIssue[] = [];
  if (!path) return issues;

  const segments = path.split("/");
  for (const seg of segments) {
    if (!seg) continue;

    if (LOCAL_FORBIDDEN_IN_SEGMENT.test(seg)) {
      const match = seg.match(LOCAL_FORBIDDEN_IN_SEGMENT)!;
      const ch = match[0];
      const label =
        ch === ":" ? "colon (:)" :
        ch === "*" ? "asterisk (*)" :
        ch === "?" ? "question mark (?)" :
        ch === '"' ? "quote (\")" :
        ch === "<" ? "less-than (<)" :
        ch === ">" ? "greater-than (>)" :
        ch === "|" ? "pipe (|)" :
        ch === "\\" ? "backslash (\\)" :
        "slash (/)";
      issues.push({
        rule: "local",
        code: "forbidden_char",
        message: `contains ${label} in "${seg}"`,
      });
    }

    const base = seg.includes(".") ? seg.slice(0, seg.lastIndexOf(".")) : seg;
    if (WINDOWS_RESERVED.has(base.toLowerCase())) {
      issues.push({
        rule: "local",
        code: "reserved_name",
        message: `reserved name: "${seg}"`,
      });
    }
  }

  return issues;
}

/** Dropbox + (선택) 로컬 규칙 통합 검사 */
export function getPathIssues(path: string, strictLocal: boolean): PathIssue[] {
  const dropbox = getDropboxPathIssues(path);
  if (!strictLocal) return dropbox;
  const local = getLocalPathIssues(path);
  const seen = new Set<string>();
  const merged: PathIssue[] = [];
  for (const i of [...dropbox, ...local]) {
    const key = `${i.rule}:${i.code}:${i.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(i);
  }
  return merged;
}

export function isPathValid(path: string, strictLocal: boolean): boolean {
  return getPathIssues(path, strictLocal).length === 0;
}

/** 자동 수정 제안: 금지 문자 치환, trailing 정리, reserved 이름 접두사 */
export function suggestFixedPath(path: string): string {
  if (!path) return path;

  const segments = path.split("/").map((seg) => {
    if (!seg) return seg;

    let fixed = seg.replace(LOCAL_FORBIDDEN_IN_SEGMENT, "-");
    fixed = fixed.replace(FORBIDDEN_CHARS, "-");
    fixed = fixed.replace(/-+/g, "-");
    fixed = fixed.replace(/^-+|-+$/g, "");

    const extIdx = fixed.lastIndexOf(".");
    const base = extIdx > 0 ? fixed.slice(0, extIdx) : fixed;
    const ext = extIdx > 0 ? fixed.slice(extIdx) : "";
    let baseName = base || fixed;

    if (!baseName) baseName = "file";

    if (WINDOWS_RESERVED.has(baseName.toLowerCase())) {
      baseName = `_${baseName}`;
    }

    fixed = baseName + ext;
    fixed = fixed.replace(/[ .]+$/g, "");
    if (!fixed) fixed = "file";

    return fixed;
  });

  return segments.join("/");
}

/** 사람이 읽기 쉬운 이슈 요약 (모달용) */
export function summarizePathIssues(issues: PathIssue[]): string {
  if (issues.length === 0) return "";
  return issues.map((i) => i.message).join("; ");
}
