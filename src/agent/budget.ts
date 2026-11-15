import type { HollowConfig } from "../config/schema.js";

/**
 * The spend cap for one `hollow fix` run. With pricing in hollow.yml it counts dollars;
 * without it, tokens. Before each call it checks the worst case (the whole prompt plus the most
 * the model may answer), so a call that could cross the cap is never made.
 */
export class Budget {
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(private readonly agent: HollowConfig["agent"]) {}

  private cost(input: number, output: number): number {
    const pricing = this.agent.pricing;
    if (pricing === undefined) return input + output;
    return (input * pricing.inputPerMillionUsd + output * pricing.outputPerMillionUsd) / 1_000_000;
  }

  private get cap(): number {
    return this.agent.pricing === undefined ? this.agent.maxTokens : this.agent.maxSpendUsd;
  }

  /** True when a call of this size fits in what is left. */
  canAfford(inputTokens: number, maxOutputTokens: number): boolean {
    return (
      this.cost(this.inputTokens, this.outputTokens) + this.cost(inputTokens, maxOutputTokens) <=
      this.cap
    );
  }

  record(inputTokens: number, outputTokens: number): void {
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
  }

  /** What the cap is, for the message before the loop starts. */
  describeCap(): string {
    return this.agent.pricing === undefined
      ? `${this.agent.maxTokens.toLocaleString("en-US")} tokens (agent.maxTokens; set agent.pricing to cap dollars instead)`
      : `$${this.agent.maxSpendUsd.toFixed(2)} (agent.maxSpendUsd, at your agent.pricing)`;
  }

  /** What was used, for the summary. */
  describeSpent(): string {
    const tokens = `${(this.inputTokens + this.outputTokens).toLocaleString("en-US")} tokens`;
    return this.agent.pricing === undefined
      ? tokens
      : `$${this.cost(this.inputTokens, this.outputTokens).toFixed(4)} (${tokens})`;
  }
}
