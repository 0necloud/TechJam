import { describe, expect, it } from "vitest";
import { classifyText } from "./sensitivity.js";

/**
 * Coverage for credential formats the hand-written patterns originally missed.
 *
 * Every value below is fake but built to the real format's specification, and
 * each spec is asserted in "fixture validity" before the detection tests run.
 * A fixture that could not exist in reality proves nothing, so the fixtures are
 * tested first.
 */
const detects = (text: string) => classifyText(text, "content").length > 0;

// Bodies are declared separately so their length can be asserted.
const STRIPE_BODY = "51H8xQ2eZvKYlo2CkQ4rTvB9nXmPqRsTuVwXyZa1B";
const GCP_BODY = "SyD1EXAMPLEfakeKEY1234567890abcdefg";
const NPM_BODY = "abcdefghijklmnopqrstuvwxyz0123456789";
const SLACK_PATH = "T00000000/B00000000/" + "X".repeat(24);
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

describe("fixture validity", () => {
  it("Stripe body is 10-99 alphanumeric characters", () => {
    expect(STRIPE_BODY).toMatch(/^[a-zA-Z0-9]{10,99}$/);
  });

  it("Google body is exactly 35 word characters", () => {
    expect(GCP_BODY).toHaveLength(35);
    expect(GCP_BODY).toMatch(/^[\w-]+$/);
  });

  it("npm body is exactly 36 lowercase alphanumeric characters", () => {
    expect(NPM_BODY).toHaveLength(36);
    expect(NPM_BODY).toMatch(/^[a-z0-9]+$/);
  });

  it("Slack path is 43-56 characters", () => {
    expect(SLACK_PATH.length).toBeGreaterThanOrEqual(43);
    expect(SLACK_PATH.length).toBeLessThanOrEqual(56);
  });

  it("AWS secret is 40 characters", () => {
    expect(AWS_SECRET).toHaveLength(40);
  });
});

describe("credential detection", () => {
  it("AWS access key ID", () => {
    expect(detects("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  it("GitHub token", () => {
    expect(detects("ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789")).toBe(true);
  });

  // A bare 40-character string is indistinguishable from a hash or UUID, so it
  // is only detectable in the assignment form real files actually contain.
  it("AWS secret access key in assignment form", () => {
    expect(detects("AWS_SECRET_ACCESS_KEY=" + AWS_SECRET)).toBe(true);
  });

  it("Stripe live key", () => {
    expect(detects("sk_live_" + STRIPE_BODY)).toBe(true);
  });

  it("Google API key", () => {
    expect(detects("AIza" + GCP_BODY)).toBe(true);
  });

  it("npm token", () => {
    expect(detects("npm_" + NPM_BODY)).toBe(true);
  });

  it("connection string with inline password", () => {
    expect(detects("postgres://admin:hunter2swordfish@db.internal:5432/app")).toBe(true);
  });

  it("Slack webhook URL", () => {
    expect(detects("https://hooks.slack.com/services/" + SLACK_PATH)).toBe(true);
  });

  it("SECRET_KEY assignment", () => {
    expect(detects('SECRET_KEY = "8f4a9c2e7b1d6350af92e8c4d7b0a1f3"')).toBe(true);
  });

  it("DB_PASS assignment", () => {
    expect(detects("DB_PASS=Tr0ub4dor3xample")).toBe(true);
  });
});

describe("known imprecision, recorded deliberately", () => {
  // The pre-existing "Credential assignment" rule matches any api_key = <8+ chars>
  // without weighing the value, so an obvious placeholder is still flagged. The
  // entropy rule added alongside it does skip this (3.29 bits, below the 3.5
  // threshold); the older rule fires first. Flagging a placeholder fails safe, so
  // this is left as-is rather than loosened, and recorded here so a future change
  // to that rule is a deliberate decision rather than an accident.
  it("flags a placeholder value", () => {
    expect(detects('api_key = "your_api_key_here"')).toBe(true);
  });
});

describe("no false positives on ordinary content", () => {
  const clean = [
    "export function classifyText(text: string, origin: SignalOrigin) {",
    'const url = "https://github.com/gitleaks/gitleaks";',
    'import { describe, expect, it } from "vitest";',
    'const hash = "d41d8cd98f00b204e9800998ecf8427e";',
    "// see https://hooks.slack.com/ for webhook docs",
    "postgres://localhost:5432/app",
    'const id = "550e8400-e29b-41d4-a716-446655440000";',
  ];

  for (const line of clean) {
    it(`ignores: ${line.slice(0, 44)}`, () => {
      expect(detects(line)).toBe(false);
    });
  }
});
