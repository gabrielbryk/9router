import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials, markAccountUnavailable, clearAccountError } =
  await import("../../src/sse/services/auth.js");

const CODEX_NORMAL_LOCK = "modelLock_codex:normal";
const CODEX_SPARK_LOCK = "modelLock_codex:spark";
const FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

function codexConn(extra = {}) {
  return { id: "codex-a", provider: "codex", name: "codex-a", isActive: true, ...extra };
}

function setConnections(...connections) {
  dbMocks.getProviderConnections.mockResolvedValue(connections);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getSettings.mockResolvedValue({});
  dbMocks.getProxyPools.mockResolvedValue([]);
  setConnections(codexConn());
});

describe("codex quota-family locks — write path", () => {
  it("locks the shared 'normal' family, not the single model, on a 429", async () => {
    setConnections(codexConn());

    await markAccountUnavailable("codex-a", 429, "rate limit exceeded", "codex", "gpt-5.6-sol");

    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).toHaveProperty(CODEX_NORMAL_LOCK);
    expect(update).not.toHaveProperty("modelLock_gpt-5.6-sol");
  });

  it("locks spark under its own family", async () => {
    await markAccountUnavailable("codex-a", 429, "rate limit exceeded", "codex", "gpt-5.3-codex-spark");

    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).toHaveProperty(CODEX_SPARK_LOCK);
    expect(update).not.toHaveProperty(CODEX_NORMAL_LOCK);
  });

  it("locks review variants under the review family", async () => {
    await markAccountUnavailable("codex-a", 429, "rate limit exceeded", "codex", "gpt-5.6-sol-review");

    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).toHaveProperty("modelLock_codex:review");
  });
});

describe("codex quota-family locks — read path", () => {
  beforeEach(() => {
    setConnections(codexConn({ [CODEX_NORMAL_LOCK]: FUTURE }));
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"])(
    "treats %s as unavailable once the shared window is locked",
    async (model) => {
      const result = await getProviderCredentials("codex", null, model);
      expect(result?.allRateLimited).toBe(true);
    },
  );

  it("leaves gpt-5.3-codex-spark selectable (separate quota window)", async () => {
    const result = await getProviderCredentials("codex", null, "gpt-5.3-codex-spark");
    expect(result?.connectionId).toBe("codex-a");
    expect(result?.allRateLimited).toBeUndefined();
  });

  it("leaves review variants selectable (separate quota window)", async () => {
    const result = await getProviderCredentials("codex", null, "gpt-5.6-sol-review");
    expect(result?.connectionId).toBe("codex-a");
  });

  it("keeps image models on per-model locks (not part of the chat windows)", async () => {
    const result = await getProviderCredentials("codex", null, "gpt-5.6-sol-image");
    expect(result?.connectionId).toBe("codex-a");
  });
});

describe("codex quota-family locks — clear path", () => {
  it("a success on one family member clears the whole family lock", async () => {
    const conn = codexConn({ [CODEX_NORMAL_LOCK]: FUTURE, testStatus: "unavailable", lastError: "429" });

    await clearAccountError("codex-a", { _connection: conn }, "gpt-5.6-luna");

    expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
      "codex-a",
      expect.objectContaining({ [CODEX_NORMAL_LOCK]: null, testStatus: "active" }),
    );
  });

  it("a success on a normal model does not clear the spark lock", async () => {
    const conn = codexConn({ [CODEX_SPARK_LOCK]: FUTURE, testStatus: "unavailable" });

    await clearAccountError("codex-a", { _connection: conn }, "gpt-5.6-luna");

    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).not.toHaveProperty(CODEX_SPARK_LOCK);
    expect(update).not.toHaveProperty("testStatus");
  });

  it("round-trips: lock the family, then clear it from a sibling model", async () => {
    await markAccountUnavailable("codex-a", 429, "rate limit exceeded", "codex", "gpt-5.6-sol");
    const written = dbMocks.updateProviderConnection.mock.calls[0][1];
    const lockKey = Object.keys(written).find(k => k.startsWith("modelLock_"));

    const conn = codexConn({ [lockKey]: written[lockKey], testStatus: "unavailable" });
    await clearAccountError("codex-a", { _connection: conn }, "gpt-5.6-terra");

    const cleared = dbMocks.updateProviderConnection.mock.calls[1][1];
    expect(cleared[lockKey]).toBeNull();
  });
});

describe("non-codex providers keep strict per-model locks", () => {
  const anthropicConn = (extra = {}) => ({
    id: "anthropic-a", provider: "anthropic", name: "anthropic-a", isActive: true, ...extra,
  });

  it("writes the raw model id as the lock key", async () => {
    setConnections(anthropicConn());

    await markAccountUnavailable("anthropic-a", 429, "rate limit", "anthropic", "claude-sonnet-4.5");

    expect(dbMocks.updateProviderConnection.mock.calls[0][1])
      .toHaveProperty("modelLock_claude-sonnet-4.5");
  });

  it("a lock on one model does not block a sibling model", async () => {
    setConnections(anthropicConn({ "modelLock_claude-sonnet-4.5": FUTURE }));

    expect((await getProviderCredentials("anthropic", null, "claude-sonnet-4.5"))?.allRateLimited).toBe(true);
    expect((await getProviderCredentials("anthropic", null, "claude-opus-4.1"))?.connectionId).toBe("anthropic-a");
  });

  it("clears only the succeeded model's lock", async () => {
    const conn = anthropicConn({
      "modelLock_claude-sonnet-4.5": FUTURE,
      "modelLock_claude-opus-4.1": FUTURE,
      testStatus: "unavailable",
    });

    await clearAccountError("anthropic-a", { _connection: conn }, "claude-sonnet-4.5");

    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).toHaveProperty("modelLock_claude-sonnet-4.5", null);
    expect(update).not.toHaveProperty("modelLock_claude-opus-4.1");
  });
});

describe("account-wide lock (modelLock___all)", () => {
  it("is written when no model is known", async () => {
    await markAccountUnavailable("codex-a", 429, "rate limit", "codex", null);

    expect(dbMocks.updateProviderConnection.mock.calls[0][1]).toHaveProperty("modelLock___all");
  });

  it("blocks every model regardless of quota family", async () => {
    setConnections(codexConn({ modelLock___all: FUTURE }));

    expect((await getProviderCredentials("codex", null, "gpt-5.6-sol"))?.allRateLimited).toBe(true);
    expect((await getProviderCredentials("codex", null, "gpt-5.3-codex-spark"))?.allRateLimited).toBe(true);
  });

  it("is cleared on any successful model", async () => {
    const conn = codexConn({ modelLock___all: FUTURE, testStatus: "unavailable" });

    await clearAccountError("codex-a", { _connection: conn }, "gpt-5.6-sol");

    expect(dbMocks.updateProviderConnection.mock.calls[0][1]).toHaveProperty("modelLock___all", null);
  });
});

describe("legacy per-model codex locks written before family scoping", () => {
  it("does not block selection and does not throw", async () => {
    setConnections(codexConn({ "modelLock_gpt-5.6-sol": FUTURE }));

    const result = await getProviderCredentials("codex", null, "gpt-5.6-sol");
    expect(result?.connectionId).toBe("codex-a");
  });

  it("is pruned once expired, alongside the new family lock", async () => {
    const conn = codexConn({
      "modelLock_gpt-5.6-sol": PAST,
      [CODEX_NORMAL_LOCK]: FUTURE,
      testStatus: "unavailable",
    });

    await clearAccountError("codex-a", { _connection: conn }, "gpt-5.6-terra");

    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).toHaveProperty("modelLock_gpt-5.6-sol", null);
    expect(update).toHaveProperty(CODEX_NORMAL_LOCK, null);
  });
});
