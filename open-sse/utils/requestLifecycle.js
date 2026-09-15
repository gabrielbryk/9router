// IDs are opaque correlation values, never credentials or unsanitized log text.
export function resolveRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : crypto.randomUUID();
}

export function withRequestId(response, requestId) {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  const exposed = headers.get("access-control-expose-headers");
  headers.set("access-control-expose-headers", exposed ? `${exposed}, x-request-id` : "x-request-id");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function throwIfRequestAborted(signal) {
  if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
}

// Remove the listener on both completion and cancellation; a canceled backoff
// must not retain a timer or start a second provider request.
export function abortableDelay(ms, signal) {
  throwIfRequestAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException("Request aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
