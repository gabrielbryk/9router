import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
  getSettings: vi.fn(),
  getCombos: vi.fn(),
  handleFetchCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getCombos: mocks.getCombos,
}));

vi.mock("open-sse/handlers/fetch/index.js", () => ({
  handleFetchCore: mocks.handleFetchCore,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));

vi.mock("@/shared/utils/ssrfGuard.js", () => ({
  assertPublicUrl: vi.fn(),
}));

import { handleFetch } from "@/sse/handlers/fetch.js";

describe("web fetch account state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getCombos.mockResolvedValue([]);
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "jina-test-key",
      connectionId: "jina-connection",
      connectionName: "Jina Test",
      _connection: {
        testStatus: "unavailable",
        lastError: "old error",
        modelLock___all: "2026-01-01T00:00:00.000Z",
      },
    });
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.handleFetchCore.mockResolvedValue({
      success: true,
      data: { provider: "jina-reader", content: { text: "ok" } },
    });
  });

  it("clears a stale provider lock after a successful fetch", async () => {
    const response = await handleFetch(new Request("http://localhost/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "jina-reader",
        url: "https://example.com/article",
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "jina-connection",
      expect.objectContaining({ connectionName: "Jina Test" }),
    );
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
  it("returns typed empty extraction without cooling down or cycling credentials", async () => {
    mocks.handleFetchCore.mockResolvedValue({ success: false, status: 502, code: "EMPTY_EXTRACTION", error: "No content" });
    const response = await handleFetch(new Request("http://localhost/v1/web/fetch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "jina-reader", url: "https://example.com/article" }),
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "EMPTY_EXTRACTION" } });
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
  });

  it("falls through empty extraction to another provider without credential cooldown", async () => {
    mocks.getCombos.mockResolvedValue([{ name: "fetch-fallback", models: ["exa", "tavily"] }]);
    mocks.handleFetchCore.mockResolvedValueOnce({ success: false, status: 502, code: "EMPTY_EXTRACTION", error: "No content" })
      .mockResolvedValueOnce({ success: true, data: { provider: "tavily", content: { text: "article" } } });
    const response = await handleFetch(new Request("http://localhost/v1/web/fetch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "fetch-fallback", url: "https://example.com/article" }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).content.text).toBe("article");
    expect(mocks.handleFetchCore.mock.calls.map(([args]) => args.provider)).toEqual(["exa", "tavily"]);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("preserves the typed error when every combo provider has empty extraction", async () => {
    mocks.getCombos.mockResolvedValue([{ name: "empty-fallback", models: ["exa", "tavily"] }]);
    mocks.handleFetchCore.mockResolvedValue({ success: false, status: 502, code: "EMPTY_EXTRACTION", error: "No content" });
    const response = await handleFetch(new Request("http://localhost/v1/web/fetch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "empty-fallback", url: "https://example.com/article" }),
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "EMPTY_EXTRACTION" } });
    expect(mocks.handleFetchCore).toHaveBeenCalledTimes(2);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("does not relabel a mixed combo failure as empty extraction", async () => {
    mocks.getCombos.mockResolvedValue([{ name: "mixed-fallback", models: ["exa", "tavily"] }]);
    mocks.handleFetchCore.mockResolvedValueOnce({ success: false, status: 502, code: "EMPTY_EXTRACTION", error: "No content" })
      .mockRejectedValueOnce(new Error("transport failed"));
    const response = await handleFetch(new Request("http://localhost/v1/web/fetch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "mixed-fallback", url: "https://example.com/article" }),
    }));
    const data = await response.json();
    expect(data.error.code).not.toBe("EMPTY_EXTRACTION");
    expect(data.error.message).toBe("transport failed");
  });

});
