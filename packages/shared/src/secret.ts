const REDACTED = "[redacted]";

/**
 * A string that cannot be logged by accident (guardrail 2 in CLAUDE.md).
 *
 * Every path that turns a value into text — template literals, string
 * concatenation, console.log, JSON.stringify, util.inspect — is overridden to
 * yield "[redacted]". The real value comes out only via an explicit .reveal(),
 * which is easy to grep for in review.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The only way out. Pass straight to a header; never into a log or a URL. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** console.log / util.inspect in Node. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }

  /** Blocks implicit coercion in template literals and `+`. */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}
