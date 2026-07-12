/**
 * The browser-safe half of `@svara/shared` — `@svara/shared/browser`.
 *
 * Client components must import from here, not from the package root. The root
 * barrel re-exports `blob.ts`, which imports `node:fs` and `node:path`, and a
 * `"use client"` file that pulls the barrel drags those into the browser bundle:
 * webpack cannot resolve the `node:` scheme for a web target and the **production
 * build fails** — while `next dev` happily serves the page, so nothing notices
 * until you try to ship. That is exactly how this repo shipped three phases of a
 * dashboard that `next build` could not compile.
 *
 * It also keeps `sarvamApiKey()` and the blob store off the client's import graph
 * entirely, which is a cheaper way to honour guardrail 2 than remembering to.
 *
 * Everything here is pure: constants, types, language codes, the wire contract,
 * and the flow config with its sanitizer. No I/O, no `process`, no `node:`.
 */
export * from "./constants.js";
export * from "./flow.js";
export * from "./hops.js";
export * from "./languages.js";
export * from "./trace.js";
export * from "./wire.js";
