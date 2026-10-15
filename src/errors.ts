import { noteRateLimit } from "./cooldown.ts";
import { OWNER } from "./settings.ts";

// The two failures that have their own message for the owner, instead of "something broke".
export class AuthError extends Error {} // the Claude login expired
export class RateLimitError extends Error {} // the plan's usage limit is hit

// What to tell the owner in their own chat.
export function errorNotice(e: unknown): string {
  return e instanceof AuthError
    ? "My login expired. On the Mac, run `claude auth login`, then message me again."
    : e instanceof RateLimitError
      ? "I've hit my usage limit for now, so I can't think until it resets. Try me again a bit later."
      : "Something broke on my end. Check the logs, I'm not telling you what it was.";
}

// What to say in a group, where nobody should be sent to a terminal.
export function groupErrorNotice(e: unknown): string {
  return e instanceof AuthError
    ? `I can't think right now: my login has expired, and ${OWNER} needs to fix it.`
    : e instanceof RateLimitError
      ? "I've hit my usage limit for now, so I can't think until it resets. Try me again a bit later."
      : "Something broke on my end, sorry. Try again in a bit.";
}

// The SDK reports a failed turn as an assistant error code and an error result.
export function failure(lastError: string | undefined, subtype: string): Error {
  if (lastError === "authentication_failed") return new AuthError("authentication_failed");
  if (lastError === "rate_limit") return noteRateLimit(), new RateLimitError("rate_limit"); // also starts the shared cooldown of background jobs (cooldown.ts)
  return new Error(`agent turn ended with ${subtype}${lastError ? ` (${lastError})` : ""}`);
}
