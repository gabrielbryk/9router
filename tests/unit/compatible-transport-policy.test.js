import { describe, it, expect } from "vitest";
import { validateCompatibleTransportPolicy, resolveCompatibleTransportPolicy } from "../../open-sse/config/compatibleTransport.js";

describe("compatible node transport policy", () => {
  it("preserves default behavior for absent and unrelated provider policy", () => {
    expect(resolveCompatibleTransportPolicy("openai-compatible-chat-local", {})).toEqual({});
    expect(resolveCompatibleTransportPolicy("codex", {providerSpecificData:{transportPolicy:{maxRetries:0}}})).toEqual({});
  });
  it("disables all gateway replay statuses explicitly and isolates each call", () => {
    const credentials = {providerSpecificData:{transportPolicy:{maxRetries:0,timeoutMs:120000}}};
    const resolved = resolveCompatibleTransportPolicy("openai-compatible-chat-local", credentials);
    expect(Object.keys(resolved.retry)).toEqual(["429", "502", "503", "504"]);
    expect(Object.values(resolved.retry).every(entry => entry.attempts === 0)).toBe(true);
    expect(resolved.timeoutMs).toBe(120000);
    resolved.retry[502].attempts = 3;
    expect(resolveCompatibleTransportPolicy("openai-compatible-chat-local", credentials).retry[502].attempts).toBe(0);
  });
  it("supports removal and independently configured timeout", () => {
    expect(validateCompatibleTransportPolicy(null)).toBe(null);
    expect(resolveCompatibleTransportPolicy("anthropic-compatible-local", {providerSpecificData:{transportPolicy:{timeoutMs:1000}}})).toEqual({timeoutMs:1000});
  });
  it.each([[],true,4,{maxRetries:-1},{maxRetries:4},{maxRetries:0.5},{timeoutMs:0},{timeoutMs:600001},{maxRetry:0}])("rejects invalid or unbounded policy %j", value => {
    expect(() => validateCompatibleTransportPolicy(value)).toThrow();
  });
});
