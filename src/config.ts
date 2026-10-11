// Secrets and the one required value, checked when the agent starts.
// (Tunables live in settings.ts.)

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

// Which credential the SDK uses, chosen explicitly via HARNESS_AUTH:
//   login (default) - your stored `claude auth login`. The only mode that can see
//                     claude.ai connectors (Notion, Calendar, Gmail...).
//   token           - CLAUDE_CODE_OAUTH_TOKEN. Long-lived, but inference-only: no connectors.
//   api-key         - ANTHROPIC_API_KEY. Metered billing, also no connectors.
// The SDK picks whatever credential is in the environment, so we remove the ones
// not chosen from this process before anything starts.
type AuthMode = "login" | "token" | "api-key";

function authMode(): AuthMode {
  const mode = process.env.HARNESS_AUTH || "login";
  if (mode !== "login" && mode !== "token" && mode !== "api-key") {
    throw new Error(`HARNESS_AUTH must be login, token or api-key (got "${mode}")`);
  }
  if (mode === "token") required("CLAUDE_CODE_OAUTH_TOKEN");
  if (mode === "api-key") required("ANTHROPIC_API_KEY");
  if (mode !== "token") delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (mode !== "api-key") delete process.env.ANTHROPIC_API_KEY;
  return mode;
}

export const config = {
  credential: authMode(),
  ownerNumber: required("SIGNAL_OWNER_NUMBER"),
};

// Numbers never go to logs in full.
export function mask(number: string | undefined): string {
  return number ? `+***${number.slice(-2)}` : "(none)";
}
