import { afterEach, describe, expect, it, vi } from "vitest";
import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";

afterEach(() => vi.unstubAllGlobals());
const request = provider => ({ provider, url: "https://example.com/article", credentials: { apiKey: "test" } });
const reply = data => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

describe("fetch extraction contract", () => {
  for (const [provider, bodies] of [
    ["exa", [{ results: [] }, { results: [{ text: " \n " }] }, { results: [{ text: {} }] }]],
    ["tavily", [{ failed_results: [{ url: "https://example.com/article", error: "failed" }] }, { results: [{ raw_content: "\t" }] }]],
    ["firecrawl", [{ data: {} }, { data: { markdown: " " } }]],
    ["jina-reader", ["", " \n\t"]],
  ]) {
    for (const body of bodies) {
      it("rejects empty " + provider + " output " + JSON.stringify(body), async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(typeof body === "string" ? new Response(body) : reply(body)));
        const result = await handleFetchCore(request(provider));
        expect(result).toMatchObject({ success: false, status: 502, code: "EMPTY_EXTRACTION" });
        expect(result).not.toHaveProperty("data");
      });
    }
  }
  it.each([
    ["exa", { results: [{ text: "full article" }] }],
    ["tavily", { results: [{ raw_content: "full article" }] }],
    ["firecrawl", { data: { markdown: " ", text: "full article" } }],
  ])("normalizes nonempty %s output and preserves truncation", async (provider, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(body)));
    const result = await handleFetchCore({ ...request(provider), maxCharacters: 4 });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ url: "https://example.com/article", content: { text: "full", length: 4, format: "markdown" } });
  });
  it("preserves actual provider status failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":"rate limited"}', { status: 429, headers: { "content-type": "application/json" } })));
    expect(await handleFetchCore(request("exa"))).toMatchObject({ success: false, status: 429, error: "rate limited" });
  });
});
