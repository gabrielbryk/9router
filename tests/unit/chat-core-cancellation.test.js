import { afterEach, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {},
    logProviderResponse() {}, logConvertedResponse() {}, logError() {},
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: async () => {}, saveRequestDetail: async () => {},
}));
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";

const options = {
  body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
  modelInfo: { provider: "openai", model: "gpt-4o" },
  credentials: { apiKey: "test", providerSpecificData: {} },
  clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
  connectionId: "test", requestId: "cancel-core-1",
};
afterEach(() => execute.mockReset());

it("propagates cancellation while the executor is still awaiting response headers", async () => {
  const controller = new AbortController();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  execute.mockImplementation(({ signal, requestId }) => new Promise((_resolve, reject) => {
    expect(requestId).toBe("cancel-core-1");
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    entered();
  }));
  const pending = handleChatCore({ ...options, signal: controller.signal });
  await ready;
  controller.abort(new Error("client departed"));
  const result = await pending;
  expect(result.status).toBe(499);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("never dispatches a request canceled before core processing", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(handleChatCore({ ...options, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(execute).not.toHaveBeenCalled();
});
