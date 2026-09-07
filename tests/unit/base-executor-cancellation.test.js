import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));
import { BaseExecutor } from "../../open-sse/executors/base.js";

afterEach(() => { vi.useRealTimers(); fetchMock.mockReset(); });
const options = { model: "test", body: {}, credentials: { apiKey: "test" }, stream: false };

describe("executor cancellation and correlation", () => {
  it("cancels a real local upstream socket before headers and never retries", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const controller = new AbortController();
    let closed;
    const received = new Promise(resolve => server.once("request", (req, res) => {
      closed = once(res, "close");
      req.resume();
      resolve(req.headers["x-request-id"]);
    }));
    fetchMock.mockImplementation((url, init) => fetch(url, init));
    const ex = new BaseExecutor("test", { baseUrl: `http://127.0.0.1:${server.address().port}`, retry: { 502: { attempts: 2, delayMs: 0 } } });
    const result = ex.execute({ ...options, signal: controller.signal, requestId: "local-probe-1" }).catch(error => error);
    try {
      expect(await received).toBe("local-probe-1");
      controller.abort(new Error("caller gone"));
      expect((await result).name).toBe("AbortError");
      await closed;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it("cancels backoff immediately and releases the retry response body", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancel = vi.fn(async () => {});
    fetchMock.mockResolvedValue({ status: 503, headers: new Headers(), body: { cancel } });
    const ex = new BaseExecutor("test", { baseUrl: "http://fake.test", retry: { 503: { attempts: 2, delayMs: 60000 } } });
    const result = ex.execute({ ...options, signal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    controller.abort();
    expect((await result).name).toBe("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps caller cancellation attached after headers while the body is streaming", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: partial\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const controller = new AbortController();
    fetchMock.mockImplementation((url, init) => fetch(url, init));
    const ex = new BaseExecutor("test", { baseUrl: `http://127.0.0.1:${server.address().port}` });
    try {
      const { response } = await ex.execute({ ...options, stream: true, signal: controller.signal });
      const reader = response.body.getReader();
      expect((await reader.read()).done).toBe(false);
      const pending = reader.read().catch(error => error);
      controller.abort();
      expect((await pending).name).toBe("AbortError");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it("makes zero network calls for a pre-aborted signal with an arbitrary reason", async () => {
    const controller = new AbortController(); controller.abort("gone");
    const ex = new BaseExecutor("test", { baseUrl: "http://fake.test" });
    await expect(ex.execute({ ...options, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
