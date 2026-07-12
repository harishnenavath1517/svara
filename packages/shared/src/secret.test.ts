import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { sarvamApiKey } from "./env.js";
import { Secret } from "./secret.js";

const KEY = "sk_test_do_not_leak_me";

afterEach(() => {
  delete process.env["SARVAM_API_KEY"];
});

describe("Secret", () => {
  it("reveals the value only on an explicit call", () => {
    expect(new Secret(KEY).reveal()).toBe(KEY);
  });

  it("redacts on every implicit path to a string", () => {
    const secret = new Secret(KEY);

    // The ways a key actually ends up in a log line.
    expect(`${secret}`).not.toContain(KEY);
    expect(String(secret)).not.toContain(KEY);
    expect(secret + "").not.toContain(KEY);
    expect(inspect(secret)).not.toContain(KEY);
    expect(JSON.stringify({ apiKey: secret })).not.toContain(KEY);
    expect(JSON.stringify([secret])).not.toContain(KEY);
  });
});

describe("sarvamApiKey", () => {
  it("loads SARVAM_API_KEY from the environment", () => {
    process.env["SARVAM_API_KEY"] = KEY;
    expect(sarvamApiKey().reveal()).toBe(KEY);
  });

  it("throws at boot when the key is unset", () => {
    expect(() => sarvamApiKey()).toThrow(/SARVAM_API_KEY/);
  });
});
