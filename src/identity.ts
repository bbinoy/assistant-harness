// Who this agent works for and what it is called. Set in .env; the defaults are neutral
// so the repo carries no personal details.
export const OWNER = process.env.OWNER_NAME || "the owner";
export const ASSISTANT = process.env.ASSISTANT_NAME || "Assistant";

// The launchd job that keeps the agent running (see scripts/install-launchd.sh).
export const LAUNCHD_LABEL = process.env.LAUNCHD_LABEL || `com.${process.env.USER ?? "user"}.assistant-harness`;
