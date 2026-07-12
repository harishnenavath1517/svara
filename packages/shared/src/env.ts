import { Secret } from "./secret.js";

/**
 * Environment access. Secrets are read from process.env and wrapped in Secret
 * so they cannot reach a log line — see guardrail 2 in CLAUDE.md.
 *
 * Load .env into process.env at the process entrypoint (`node --env-file=.env`
 * or Next.js's built-in loading). Nothing here reads a file.
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

/** Throws if unset, so a misconfigured process dies at boot, not mid-call. */
export function requireSecret(name: string): Secret {
  return new Secret(requireEnv(name));
}

export function sarvamApiKey(): Secret {
  return requireSecret("SARVAM_API_KEY");
}
