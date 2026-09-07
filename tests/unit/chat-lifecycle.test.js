import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credentials: vi.fn(), markUnavailable: vi.fn(), core: vi.fn(),
  settings: vi.fn(), model: vi.fn(),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials, markAccountUnavailable: mocks.markUnavailable,
  clearAccountError: vi.fn(), extractApiKey: () => null, isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.settings }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: mocks.model, getComboModels: async () => null }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({ handleAntigravityQuotaError: vi.fn() }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.core }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

import { handleChat } from "@/sse/handlers/chat.js";

function request(signal, requestId = "trace.test-1") {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ model: "local/test", messages: [{ role: "user", content: "test" }] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({});
  mocks.model.mockResolvedValue({ provider: "openai-compatible-local", model: "test" });
  mocks.credentials.mockResolvedValue({
    apiKey: "test", connectionId: "local", providerSpecificData: { transportPolicy: { maxRetries: 0 } },
  });
  mocks.markUnavailable.mockResolvedValue({ shouldFallback: false });
  mocks.core.mockResolvedValue({ success: true, response: new Response("ok") });
});

describe("chat request lifecycle", () => {
  it("propagates the incoming signal and one sanitized correlation ID", async () => {
    const controller = new AbortController();
    const req = request(controller.signal);
    const response = await handleChat(req);
    expect(mocks.core.mock.calls[0][0]).toMatchObject({ signal: req.signal, requestId: "trace.test-1" });
    expect(response.headers.get("x-request-id")).toBe("trace.test-1");
    expect(await response.text()).toBe("ok");
  });

  it("generates a safe ID instead of echoing invalid input, including early errors", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "x-request-id": "invalid id with spaces" }, body: "{bad",
    });
    const response = await handleChat(req);
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(mocks.core).not.toHaveBeenCalled();
  });

  it("does not select accounts for an already canceled request", async () => {
    const controller = new AbortController(); controller.abort(new Error("caller left"));
    expect((await handleChat(request(controller.signal))).status).toBe(499);
    expect(mocks.credentials).not.toHaveBeenCalled();
  });

  it("does not penalize credentials or try another account after pre-header cancellation", async () => {
    const controller = new AbortController();
    mocks.core.mockImplementation(async ({ signal }) => {
      controller.abort(new Error("caller left"));
      expect(signal.aborted).toBe(true);
      return { success: false, status: 502, error: "fetch failed", response: new Response("failed", { status: 502 }) };
    });
    expect((await handleChat(request(controller.signal))).status).toBe(499);
    expect(mocks.credentials).toHaveBeenCalledTimes(1);
    expect(mocks.markUnavailable).not.toHaveBeenCalled();
  });

  it.each([[429, "rate limited"], [503, "overloaded"], [500, "Engine queue is full"]])(
    "preserves capacity error %s without credential cooldown for an explicit single-attempt node",
    async (status, error) => {
      mocks.core.mockResolvedValue({ success: false, status, error, response: new Response(error, { status }) });
      expect((await handleChat(request())).status).toBe(status);
      expect(mocks.credentials).toHaveBeenCalledTimes(1);
      expect(mocks.markUnavailable).not.toHaveBeenCalled();
    },
  );

  it("keeps normal account error handling when the node has no explicit retry policy", async () => {
    mocks.credentials.mockResolvedValue({ apiKey: "test", connectionId: "local", providerSpecificData: {} });
    mocks.core.mockResolvedValue({ success: false, status: 503, error: "overloaded", response: new Response("busy", { status: 503 }) });
    expect((await handleChat(request())).status).toBe(503);
    expect(mocks.markUnavailable).toHaveBeenCalledTimes(1);
  });
});
