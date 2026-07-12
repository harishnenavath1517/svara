/**
 * The Node surface: everything, including the parts that touch the filesystem and
 * the API key. Gateway, worker, sink, eval and the dashboard's *server* components
 * import this.
 *
 * A client component must import `@svara/shared/browser` instead — see browser.ts.
 * `blob.ts` reaches for `node:fs`, and pulling it into a browser bundle breaks
 * `next build` (though not `next dev`, which is how it goes unnoticed).
 */
export * from "./browser.js";

export * from "./blob.js";
export * from "./env.js";
export * from "./secret.js";
export * from "./wav.js";
