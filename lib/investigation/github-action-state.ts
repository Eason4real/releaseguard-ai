import type { AuditEvent, ToolCallWithResult, ToolResult } from "./types";

export const GITHUB_ACTION_LEASE_MS = 60_000;

export type FrozenGithubTarget = {
  owner: string;
  repo: string;
};

export type ValidatedGithubIssue = {
  number: number;
  title: string;
  url: string;
  repository: FrozenGithubTarget;
  createdAt: string;
  deduplicated: boolean;
};

export type GithubActionClaimOutcome =
  | "CLAIMED"
  | "ALREADY_COMPLETED"
  | "EXECUTION_IN_PROGRESS"
  | "RECONCILIATION_REQUIRED"
  | "INVALID_STATE";

export type GithubActionClaimInput = {
  mode: "INITIAL" | "RECLAIM";
  runId: string;
  proposedActionId: string;
  approvalId: string;
  approvalSnapshotId: string;
  toolCallId: string;
  expectedLockVersion: number;
  previousAttemptId: string | null;
  previousLeaseExpiresAt: string | null;
  frozenTarget: FrozenGithubTarget;
  attemptId: string;
  claimedAt: string;
  leaseExpiresAt: string;
  auditEvent: AuditEvent;
};

export type GithubActionDispatchInput = {
  runId: string;
  proposedActionId: string;
  approvalId: string;
  toolCallId: string;
  attemptId: string;
  dispatchedAt: string;
  auditEvent: AuditEvent;
};

export type GithubActionSettlementInput = {
  runId: string;
  proposedActionId: string;
  approvalId: string;
  toolCallId: string;
  attemptId: string;
  result: ToolResult;
  settledAt: string;
  auditEvent: AuditEvent;
};

export type GithubActionReconciliationInput = {
  runId: string;
  proposedActionId: string;
  approvalId: string;
  toolCallId: string;
  attemptId: string;
  observedAt: string;
  reasonCode: string;
  auditEvent: AuditEvent;
};

export class GithubIssueResponseValidationError extends Error {
  readonly name = "GithubIssueResponseValidationError";

  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

const invalid = (code: string, path: string, message: string): never => {
  throw new GithubIssueResponseValidationError(code, path, message);
};

const repositoryPart = (value: string, path: string) => {
  const normalized = value.trim();
  if (!normalized || !/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    invalid("INVALID_GITHUB_REPOSITORY", path, "GitHub owner/repository 格式不正确。");
  }
  return normalized.toLowerCase();
};

export function normalizeGithubTarget(target: FrozenGithubTarget): FrozenGithubTarget {
  return {
    owner: repositoryPart(target.owner, "repository.owner"),
    repo: repositoryPart(target.repo, "repository.repo"),
  };
}

const parseSafeUrl = (value: unknown, path: string) => {
  if (typeof value !== "string" || !value || value.includes("%")) {
    invalid("INVALID_GITHUB_URL", path, "GitHub URL 不完整或包含编码绕过。");
  }
  const raw = value as string;
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    invalid("INVALID_GITHUB_URL", path, "GitHub URL 格式不正确。");
  }
  if (!parsed) invalid("INVALID_GITHUB_URL", path, "GitHub URL 格式不正确。");
  const safeParsed = parsed as URL;
  if (safeParsed.protocol !== "https:" || safeParsed.username || safeParsed.password
    || safeParsed.port || safeParsed.search || safeParsed.hash) {
    invalid("INVALID_GITHUB_URL", path, "GitHub URL 必须是无用户信息、端口、查询或片段的 HTTPS URL。");
  }
  return safeParsed;
};

const validateWebIssueUrl = (
  value: unknown,
  target: FrozenGithubTarget,
  number: number,
  path: string,
) => {
  const parsed = parseSafeUrl(value, path);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (parsed.hostname !== "github.com"
    || segments.length !== 4
    || segments[0].toLowerCase() !== target.owner
    || segments[1].toLowerCase() !== target.repo
    || segments[2] !== "issues"
    || segments[3] !== String(number)) {
    invalid("GITHUB_ISSUE_TARGET_MISMATCH", path, "Issue URL 与 Approval 冻结仓库或 number 不一致。");
  }
  return parsed.toString();
};

const validateApiUrl = (
  value: unknown,
  target: FrozenGithubTarget,
  number: number | null,
  path: string,
) => {
  if (value === undefined) return;
  const parsed = parseSafeUrl(value, path);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const expectedLength = number === null ? 3 : 5;
  if (parsed.hostname !== "api.github.com"
    || segments.length !== expectedLength
    || segments[0] !== "repos"
    || segments[1].toLowerCase() !== target.owner
    || segments[2].toLowerCase() !== target.repo
    || (number !== null && (segments[3] !== "issues" || segments[4] !== String(number)))) {
    invalid("GITHUB_API_TARGET_MISMATCH", path, "GitHub API URL 与 Approval 冻结仓库不一致。");
  }
};

const issueNumber = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    invalid("INVALID_GITHUB_ISSUE_NUMBER", "number", "Issue number 必须是正的安全整数。");
  }
  return Number(value);
};

export function validateGithubIssueResponse(
  response: unknown,
  frozenTarget: FrozenGithubTarget,
  input: { deduplicated: boolean; observedAt: string },
): ValidatedGithubIssue {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    invalid("INVALID_GITHUB_RESPONSE", "$", "GitHub Issue response 必须是对象。");
  }
  const raw = response as Record<string, unknown>;
  const target = normalizeGithubTarget(frozenTarget);
  const number = issueNumber(raw.number);
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) invalid("INVALID_GITHUB_ISSUE_TITLE", "title", "Issue title 不能为空。");
  const url = validateWebIssueUrl(raw.html_url, target, number, "html_url");
  validateApiUrl(raw.repository_url, target, null, "repository_url");
  validateApiUrl(raw.url, target, number, "url");
  const createdAt = typeof raw.created_at === "string" && !Number.isNaN(Date.parse(raw.created_at))
    ? raw.created_at
    : input.observedAt;
  return { number, title, url, repository: target, createdAt, deduplicated: input.deduplicated };
}

export function parsePersistedGithubIssue(
  output: unknown,
  frozenTarget: FrozenGithubTarget,
): ValidatedGithubIssue | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const raw = output as Record<string, unknown>;
  const repository = raw.repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) return null;
  const repo = repository as Record<string, unknown>;
  try {
    const target = normalizeGithubTarget(frozenTarget);
    if (repo.owner !== target.owner || repo.repo !== target.repo) return null;
    const number = issueNumber(raw.number);
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title || typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) return null;
    const url = validateWebIssueUrl(raw.url, target, number, "url");
    return {
      number,
      title,
      url,
      repository: target,
      createdAt: raw.createdAt,
      deduplicated: raw.deduplicated === true,
    };
  } catch (error) {
    if (error instanceof GithubIssueResponseValidationError) return null;
    throw error;
  }
}

export function isCanonicalCompletedToolCall(call: ToolCallWithResult | null | undefined) {
  return call?.status === "COMPLETED" && call.result?.status === "SUCCESS";
}

export function resolveValidatedGithubIssue(
  call: ToolCallWithResult | null | undefined,
  frozenTarget: FrozenGithubTarget | null,
) {
  if (!isCanonicalCompletedToolCall(call) || !frozenTarget) return null;
  return parsePersistedGithubIssue(call?.result?.output, frozenTarget);
}
