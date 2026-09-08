import { beforeEach, describe, expect, it, vi } from "vitest";

// Auto-ping picks the quota window it warms by REAL window duration (`windowSeconds`),
// not by the position-derived key name. These tests use the real QUOTA_AUTOPING_CONFIG
// so config drift (thresholds, non-warmable families) is caught here.

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("open-sse/services/usage/claude.js", () => ({
  getClaudeUsage: vi.fn(),
}));

vi.mock("open-sse/services/usage/codex.js", () => ({
  getCodexUsage: vi.fn(),
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(),
}));

const FIVE_HOURS = 18000;
const SEVEN_DAYS = 604800;
const CODEX_CONN = { id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" };

function quota(resetAt, windowSeconds, overrides = {}) {
  return { used: 1, total: 100, remaining: 99, resetAt, windowSeconds, ...overrides };
}

describe("codex auto-ping window selection", () => {
  let runQuotaAutoPingTick;
  let deps;
  let state;
  let getCodexUsage;
  let getClaudeUsage;
  let getExecutor;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete global.__quotaAutoPing;

    ({ getCodexUsage } = await import("open-sse/services/usage/codex.js"));
    ({ getClaudeUsage } = await import("open-sse/services/usage/claude.js"));
    ({ getExecutor } = await import("open-sse/executors/index.js"));
    ({ runQuotaAutoPingTick } = await import("../../src/shared/services/quotaAutoPing.js"));

    deps = {
      getSettings: vi.fn(),
      getProviderConnections: vi.fn(),
      updateProviderConnection: vi.fn(),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      proxyAwareFetch: vi.fn().mockResolvedValue({ ok: true }),
      getExecutor: vi.fn(() => ({
        execute: vi.fn().mockResolvedValue({ response: { ok: true, text: vi.fn().mockResolvedValue("") } }),
      })),
    };
    getExecutor.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ response: { ok: true, text: vi.fn().mockResolvedValue("") } }),
    });
    state = { running: false, resetCache: {}, failureCache: {} };
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  function enableCodex(connection = CODEX_CONN) {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { [connection.id]: true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [connection] : []
    ));
    // Codex only pings once resetAt slides forward, so seed the previous observation.
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
  }

  it("warms the 5h window on a Team-shaped account (session 18000s beats weekly 604800s)", async () => {
    enableCodex();
    getCodexUsage.mockResolvedValue({
      quotas: {
        session: quota("2026-01-01T17:01:00.000Z", FIVE_HOURS),
        weekly: quota("2026-01-05T12:00:00.000Z", SEVEN_DAYS),
        spark_session: quota("2026-01-01T17:01:00.000Z", FIVE_HOURS),
        spark_weekly: quota("2026-01-05T12:00:00.000Z", SEVEN_DAYS),
      },
    });

    await runQuotaAutoPingTick(deps, state);

    const executor = deps.getExecutor.mock.results[0].value;
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T17:01:00.000Z",
    }));
  });

  it("prefers the shortest timed window even when the usage handler emits an unusual duration key", async () => {
    enableCodex();
    getCodexUsage.mockResolvedValue({
      quotas: {
        session: quota("2026-01-01T17:01:00.000Z", FIVE_HOURS),
        window_43200: quota("2026-01-02T00:00:00.000Z", 43200),
        weekly: quota("2026-01-05T12:00:00.000Z", SEVEN_DAYS),
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T17:01:00.000Z",
    }));
  });

  it("warms a duration-derived key when the handler emits no `session` key", async () => {
    enableCodex();
    getCodexUsage.mockResolvedValue({
      quotas: {
        window_18000: quota("2026-01-01T17:01:00.000Z", FIVE_HOURS),
        weekly: quota("2026-01-05T12:00:00.000Z", SEVEN_DAYS),
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T17:01:00.000Z",
    }));
  });

  it("refuses to warm a `session`-named window whose real duration is a week (#the Pro mislabel bug)", async () => {
    enableCodex();
    getCodexUsage.mockResolvedValue({
      quotas: { session: quota("2026-01-05T12:00:00.000Z", SEVEN_DAYS) },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not warm a Pro account's 5h SPARK window: the main-family ping model cannot start it", async () => {
    enableCodex();
    getCodexUsage.mockResolvedValue({
      quotas: {
        weekly: quota("2026-01-05T12:00:00.000Z", SEVEN_DAYS),
        spark_session: quota("2026-01-01T17:01:00.000Z", FIVE_HOURS),
        spark_weekly: quota("2026-01-05T12:00:00.000Z", SEVEN_DAYS),
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("skips a Pro-shaped account with no sub-daily window and writes no ping state", async () => {
    enableCodex();
    getCodexUsage.mockResolvedValue({
      quotas: { weekly: quota("2026-01-05T12:00:00.000Z", SEVEN_DAYS) },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    // No state churn: the seeded reset cache is untouched and no failure is recorded.
    expect(state.resetCache["codex:codex-1"]).toBe("2026-01-01T17:00:00.000Z");
    expect(state.failureCache["codex:codex-1"]).toBeUndefined();
  });

  it("skips a Pro-shaped account whose only long window is reported without a duration", async () => {
    enableCodex();
    getCodexUsage.mockResolvedValue({
      quotas: { weekly: quota("2026-01-05T12:00:00.000Z", null) },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("still suppresses the ping when a blocking (weekly) quota is exhausted", async () => {
    enableCodex();
    getCodexUsage.mockResolvedValue({
      quotas: {
        session: quota("2026-01-01T17:01:00.000Z", FIVE_HOURS),
        weekly: quota("2026-01-05T12:00:00.000Z", SEVEN_DAYS, { used: 100, remaining: 0 }),
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not treat an exhausted sibling 5h window as blocking", async () => {
    enableCodex();
    getCodexUsage.mockResolvedValue({
      quotas: {
        session: quota("2026-01-01T17:01:00.000Z", FIVE_HOURS),
        spark_session: quota("2026-01-01T17:01:00.000Z", FIVE_HOURS, { used: 100, remaining: 0 }),
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T17:01:00.000Z",
    }));
  });

  it("keeps Claude key-name selection when quotas carry no windowSeconds", async () => {
    deps.getSettings.mockResolvedValue({ claudeAutoPing: { connections: { "claude-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "claude" ? [{ id: "claude-1", provider: "claude", authType: "oauth", accessToken: "token" }] : []
    ));
    getClaudeUsage.mockResolvedValue({
      quotas: {
        "session (5h)": { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T11:59:00.000Z" },
        "weekly (7d)": { used: 1, total: 100, remaining: 99, resetAt: "2026-01-05T12:00:00.000Z" },
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(deps.proxyAwareFetch.mock.calls[0][1].body)).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
    });
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("claude-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T11:59:00.000Z",
    }));
  });
});
