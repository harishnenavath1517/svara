import type { NextConfig } from "next";

/**
 * Internal packages resolve to TypeScript source — there is no build step for
 * them (see CLAUDE.md). Next transpiles them itself.
 */
const config: NextConfig = {
  transpilePackages: ["@svara/shared"],

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
