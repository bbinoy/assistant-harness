import { query, startup, type Options, type SDKMessage, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { settings } from "./settings.ts";
import { firstWarm, SpareSlot } from "./warmslot.ts";

// A warm Haiku process for one judge (the approval-wait judge in judge.ts, the auto-approve judge in autojudge.ts).
// Each judge has its own system prompt and output schema, and those are fixed when a process starts, so each judge owns
// its own JudgeSpare (its own slot, keyed by its options): a spare built for one is never handed to the other.
// Same mechanism and settings as every warm process: WARM=off starts cold every time, WARM_IDLE_MINUTES drops an idle one.
export interface JudgeIO {
  start?: typeof startup;
  query?: typeof query;
}

const ID = "judge";

export class JudgeSpare {
  readonly #options: Options;
  readonly #label: string;
  readonly #key: string;
  readonly #slot = new SpareSlot<WarmQuery>({ maxAgeMs: settings.warmIdleMinutes * 60_000, idleMs: () => settings.warmIdleMinutes * 60_000 });

  constructor(label: string, options: Options) {
    this.#label = label;
    this.#options = options;
    this.#key = JSON.stringify(options);
  }

  // Start the next process in the background (it serves one query). Already warm: only keeps it from going idle.
  prepare(io: JudgeIO = {}): void {
    if (!settings.warm) return;
    if (this.#slot.has(ID, this.#key)) return void this.#slot.touch(ID);
    const warm = (io.start ?? startup)({ options: this.#options });
    warm.catch((e) => console.error(`${this.#label} warm-up failed:`, (e as Error).message));
    this.#slot.put(ID, this.#key, warm);
  }

  discard(): void {
    this.#slot.drop();
  }

  // The messages of one query: on the spare when there is a live one, else a cold start (also when the spare turns out dead).
  async run(prompt: string, io: JudgeIO = {}): Promise<{ messages: AsyncIterable<SDKMessage>; warm: boolean }> {
    const cold = () => (io.query ?? query)({ prompt, options: this.#options });
    const warm = await this.#slot.take(ID, this.#key)?.catch((e: Error) => console.error(`${this.#label}: warm process unavailable, starting normally:`, e.message));
    if (!warm) return { messages: cold(), warm: false };
    return { messages: firstWarm(() => warm.query(prompt), cold, (e) => console.error(`${this.#label}: warm process failed, starting normally:`, e.message)), warm: true };
  }
}
