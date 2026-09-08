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

async function loadUsage(payload) {
  mocks.proxyAwareFetch.mockResolvedValue({ ok: true, status: 200, json: async () => payload });
  const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
  return getCodexUsage("token");
}

describe("Codex usage extra signals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses applicableCount independently of availableCount", async () => {
    const usage = await loadUsage(PAYLOADS.pro_account_1);

    expect(usage.resetCredits.availableCount).toBe(3);
    expect(usage.resetCredits.applicableCount).toBe(0);
  });

  it("parses a non-zero applicableCount", async () => {
    const usage = await loadUsage({
      ...PAYLOADS.pro_account_2,
      rate_limit_reset_credits: { available_count: 5, applicable_available_count: 2 },
    });

    expect(usage.resetCredits.availableCount).toBe(5);
    expect(usage.resetCredits.applicableCount).toBe(2);
  });

  it("normalizes model_usage", async () => {
    const usage = await loadUsage({
      ...PAYLOADS.pro_account_1,
      model_usage: {
        "gpt-6-astra": { available: true, available_at: null, credits_would_enable: false },
        "gpt-6-locked": { available: false, available_at: 1789456374, credits_would_enable: true },
      },
    });

    expect(usage.modelUsage["gpt-6-astra"]).toEqual({
      available: true,
      availableAt: null,
      creditsWouldEnable: false,
    });
    expect(usage.modelUsage["gpt-6-locked"]).toEqual({
      available: false,
      availableAt: new Date(1789456374 * 1000).toISOString(),
      creditsWouldEnable: true,
    });
  });

  it("normalizes spend_control.individual_limit for team accounts", async () => {
    const usage = await loadUsage(PAYLOADS.team_account_3);

    expect(usage.spendControl.reached).toBe(false);
    expect(usage.spendControl.individualLimit).toEqual({
      source: "account_user_spend_controls",
      limit: 2500,
      used: 0,
      remaining: 2500,
      usedPercent: 0,
      remainingPercent: 100,
      resetAfterSeconds: 1947519,
      resetAt: new Date(1790812800 * 1000).toISOString(),
    });
  });

  it("leaves individualLimit null when the plan has none", async () => {
    const usage = await loadUsage(PAYLOADS.pro_account_1);

    expect(usage.spendControl).toEqual({ reached: false, individualLimit: null });
  });

  it("surfaces the credits block", async () => {
    const pro = await loadUsage(PAYLOADS.pro_account_1);
    expect(pro.credits).toMatchObject({ hasCredits: false, unlimited: false, balance: 0 });

    const team = await loadUsage(PAYLOADS.team_account_3);
    expect(team.credits).toMatchObject({ hasCredits: true, balance: null });
  });

  it("returns nulls rather than throwing when the blocks are absent", async () => {
    const usage = await loadUsage({ plan_type: "plus", rate_limit: {} });

    expect(usage.modelUsage).toBeNull();
    expect(usage.spendControl).toBeNull();
    expect(usage.credits).toBeNull();
    expect(usage.resetCredits).toEqual({ availableCount: 0, applicableCount: 0 });
  });
});
