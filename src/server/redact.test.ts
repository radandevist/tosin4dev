import { afterEach, describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("redactSecrets", () => {
  it("scrubs a live env secret wherever it appears", () => {
    process.env.my_api_token = "s3cr3t-value-9999";

    const out = redactSecrets(
      "first=s3cr3t-value-9999 second=s3cr3t-value-9999",
    );

    expect(out).toBe("first=[REDACTED] second=[REDACTED]");
  });

  it("ignores short env values so common substrings survive", () => {
    process.env.SOME_KEY = "abc";

    expect(redactSecrets("abc def abc")).toBe("abc def abc");
  });

  it("ignores env vars whose name is not secret-shaped", () => {
    process.env.NODE_ENV = "development-mode";

    expect(redactSecrets("development-mode")).toBe("development-mode");
  });

  it.each([
    ["sk-abcdefghijklmnopqrstuvwx"],
    ["ghp_abcdefghijklmnopqrstuvwxyz12"],
    ["AKIAIOSFODNN7EXAMPLE"],
    ["Bearer abcdefghijklmnopqrstuvwxyz"],
    [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    ],
  ])("scrubs shape-detected secret %s", (secret) => {
    const out = redactSecrets(`before token=${secret} after`);

    expect(out).toBe("before token=[REDACTED] after");
  });

  it("leaves ordinary text untouched", () => {
    const text = "ran bun test, 199 passed, committed as a1e50cb";

    expect(redactSecrets(text)).toBe(text);
  });

  it("scrubs an env secret containing regex metacharacters", () => {
    process.env.DATABASE_PASSWORD = "p@ss+w[0]rd.secret*x";

    expect(() =>
      redactSecrets("password=p@ss+w[0]rd.secret*x"),
    ).not.toThrow();
    expect(redactSecrets("password=p@ss+w[0]rd.secret*x")).toBe(
      "password=[REDACTED]",
    );
  });

  it("scrubs multiple different env secrets in one string", () => {
    process.env.SERVICE_TOKEN = "first-secret-value";
    process.env.SERVICE_PASSWORD = "second-secret-value";

    expect(
      redactSecrets("one=first-secret-value two=second-secret-value"),
    ).toBe("one=[REDACTED] two=[REDACTED]");
  });

  it("handles empty and secret-free strings unchanged", () => {
    expect(redactSecrets("")).toBe("");

    const text = "nothing sensitive appears here";
    expect(redactSecrets(text)).toBe(text);
  });

  it("scrubs an env secret embedded within a longer token", () => {
    process.env.EMBEDDED_SECRET = "inner-secret";

    expect(redactSecrets("prefixinner-secretsuffix")).toBe(
      "prefix[REDACTED]suffix",
    );
  });
});
