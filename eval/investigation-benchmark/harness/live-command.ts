export type LiveHarnessCommand =
  | { mode: "PREFLIGHT" }
  | { mode: "DEV"; caseId?: string };

export function resolveLiveHarnessCommand(args: string[]): LiveHarnessCommand {
  if (!args.includes("--provider=live")) {
    throw new Error("LIVE_BENCHMARK_EXPLICIT_OPT_IN_REQUIRED");
  }
  const preflight = args.includes("--preflight");
  const caseArguments = args.filter((item) => item.startsWith("--case="));
  if (caseArguments.length > 1) throw new Error("MULTIPLE_LIVE_CASE_ARGUMENTS");
  const caseId = caseArguments[0]?.slice("--case=".length);
  if (preflight && caseId !== undefined) throw new Error("PREFLIGHT_CASE_ARGUMENT_FORBIDDEN");
  return preflight ? { mode: "PREFLIGHT" } : { mode: "DEV", ...(caseId ? { caseId } : {}) };
}
