import type { NextConfig } from "next";

/**
 * Internal packages resolve to TypeScript source — there is no build step for
 * them (see CLAUDE.md). Next transpiles them itself.
 */
const config: NextConfig = {
  transpilePackages: ["@svara/shared", "@svara/db", "@svara/eval"],

  // `pg` is a Node driver with dynamic requires; bundling it breaks it. The
  // dashboard's pages are server components that query Postgres directly, so it
  // has to stay a real Node import.
  serverExternalPackages: ["pg"],

  webpack(config) {
    // `@svara/shared` is ESM TypeScript: its internal imports say "./trace.js",
    // and the file on disk is trace.ts. Node and tsc both understand that;
    // webpack needs to be told.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default config;
