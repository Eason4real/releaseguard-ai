const configured = Boolean(
  process.env.LIVE_EVAL_API_KEY
  && process.env.LIVE_EVAL_BASE_URL
  && process.env.LIVE_EVAL_MODEL,
);
if (!configured) {
  console.log("Live LLM Eval skipped: LIVE_EVAL_API_KEY, LIVE_EVAL_BASE_URL and LIVE_EVAL_MODEL are not configured.");
  process.exit(0);
}
console.log("Live LLM Eval is configured. Run the hosted Phase 3 investigation endpoint with the selected provider; this non-blocking command does not expose the API key.");
