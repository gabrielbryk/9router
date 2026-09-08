import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

const PAYLOADS = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/codex-usage-payloads.json", import.meta.url)), "utf8"),
);

const FIVE_HOURS = 18000;
const SEVEN_DAYS = 604800;
const THIRTY_DAYS = 2592000;

async function loadUsage(payload) {
  mocks.proxyAwareFetch.mockResolvedValue({ ok: true, status: 200, json: async () => payload });
  const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
  return getCodexUsage("token");
}

describe("Codex quota window classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("labels a Pro 7-day primary window as weekly, not session", async () => {
    const usage = await loadUsage(PAYLOADS.pro_account_1);

    expect(usage.quotas.session).toBeUndefined();
    expect(usage.quotas.weekly).toBeDefined();
    expect(usage.quotas.weekly.used).toBe(15);
    expect(usage.quotas.weekly.windowSeconds).toBe(SEVEN_DAYS);
    expect(usage.quotas.weekly.resetAt).toBe(new Date(1789456374 * 1000).toISOString());
  });

  it("classifies both Team windows by duration", async () => {
    const usage = await loadUsage(PAYLOADS.team_account_3);

    expect(usage.quotas.session.windowSeconds).toBe(FIVE_HOURS);
    expect(usage.quotas.session.used).toBe(13);
    expect(usage.quotas.weekly.windowSeconds).toBe(SEVEN_DAYS);
    expect(usage.quotas.weekly.used).toBe(2);
  });

  it("uses the same classifier for the spark family", async () => {
    const usage = await loadUsage(PAYLOADS.pro_account_2);

    expect(usage.quotas.spark_session.windowSeconds).toBe(FIVE_HOURS);
    expect(usage.quotas.spark_weekly.windowSeconds).toBe(SEVEN_DAYS);
    expect(usage.quotas.spark_weekly.resetAt).toBe(new Date(1789470081 * 1000).toISOString());
  });

  it("falls back to positional labelling when limit_window_seconds is missing", async () => {
    const usage = await loadUsage({
      ...PAYLOADS.team_account_3,
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: 1788874577 },
        secondary_window: { used_percent: 20, reset_at: 1789461377 },
      },
    });

    expect(usage.quotas.session.used).toBe(10);
    expect(usage.quotas.session.windowSeconds).toBeNull();
    expect(usage.quotas.weekly.used).toBe(20);
    expect(usage.quotas.weekly.windowSeconds).toBeNull();
  });

  it("surfaces an unexpected window duration under a duration-derived key", async () => {
    const usage = await loadUsage({
      ...PAYLOADS.pro_account_1,
      rate_limit: {
        primary_window: { used_percent: 7, limit_window_seconds: 43200, reset_at: 1788874577 },
        secondary_window: null,
      },
      additional_rate_limits: null,
    });

    expect(usage.quotas.session).toBeUndefined();
    expect(usage.quotas.weekly).toBeUndefined();
    expect(usage.quotas.window_43200).toBeDefined();
    expect(usage.quotas.window_43200.used).toBe(7);
    expect(usage.quotas.window_43200.windowSeconds).toBe(43200);
  });

  it("keeps both long windows when two slots classify to weekly", async () => {
    const usage = await loadUsage({
      ...PAYLOADS.pro_account_1,
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: SEVEN_DAYS, reset_at: 1789456374 },
        secondary_window: { used_percent: 60, limit_window_seconds: THIRTY_DAYS, reset_at: 1791456374 },
      },
      additional_rate_limits: null,
    });

    // Neither window may be silently dropped by a key collision.
    expect(usage.quotas.weekly).toBeDefined();
    expect(usage.quotas.weekly.used).toBe(30);
    expect(usage.quotas.weekly.windowSeconds).toBe(SEVEN_DAYS);

    expect(usage.quotas.window_2592000).toBeDefined();
    expect(usage.quotas.window_2592000.used).toBe(60);
    expect(usage.quotas.window_2592000.windowSeconds).toBe(THIRTY_DAYS);

    const windows = Object.values(usage.quotas).map((q) => q.windowSeconds);
    expect(windows).toContain(SEVEN_DAYS);
    expect(windows).toContain(THIRTY_DAYS);
  });

  it("does not drop a second window with an identical duration", async () => {
    const usage = await loadUsage({
      ...PAYLOADS.pro_account_1,
      rate_limit: {
        primary_window: { used_percent: 11, limit_window_seconds: SEVEN_DAYS, reset_at: 1789456374 },
        secondary_window: { used_percent: 22, limit_window_seconds: SEVEN_DAYS, reset_at: 1791456374 },
      },
      additional_rate_limits: null,
    });

    const used = Object.values(usage.quotas).map((q) => q.used).sort((a, b) => a - b);
    expect(used).toEqual([11, 22]);
  });

  it("keeps existing quota fields intact", async () => {
    const usage = await loadUsage(PAYLOADS.team_account_3);

    expect(usage.quotas.session).toMatchObject({ total: 100, remaining: 87, unlimited: false });
    expect(usage.plan).toBe("team");
    expect(usage.limitReached).toBe(false);
  });
});
