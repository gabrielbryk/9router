# DSH gateway reliability patch

Based on exact production revision 90b52e06ffd666b7929554211474d01588f6b1f8,
without upgrading the pre-existing Fork Fleet candidate. Creating session:
DSH session-audit gateway subagent, 2026-09-07; opaque agent session ID unavailable.

Compatible nodes accept transportPolicy { maxRetries: 0..3, timeoutMs:
1000..600000 } through create/update APIs. Null removes the override; omitted
policy preserves existing behavior. The update propagates to connections.
The Muninn LocalLiteLLM node uses maxRetries=0. Other provider defaults remain.
Configured single-attempt local capacity errors do not mark credentials bad.

Incoming cancellation reaches the compatible executor before response headers;
retry sleeps abort and release response bodies. Sanitized request IDs are echoed,
logged and forwarded through the BaseExecutor path. Custom executors that bypass
BaseExecutor do not inherit request-ID forwarding automatically.

Fetch providers reject whitespace/non-string/missing extraction with
EMPTY_EXTRACTION, permit combo fallback and preserve credential health.
Firecrawl prefers the first nonempty supported output field.

Validation: 59 focused tests passed, including real ephemeral fake HTTP backends
for cancellation before and after headers, zero retry policy, extraction and
combo behavior. A Docker build and compiled create/update policy roundtrip pass.
No broad provider completion probes are required. Existing full-suite failures
are outside this narrow patch; no unrelated failed Fork Fleet patches included.

Dockerfile.dsh pins the Node base digest, consumes the locally frozen package
lock, and carries source revision labels. Build a unique local tag, transfer by
docker save/load, verify identical image IDs, update the owning Coolify service
image with pull_policy=never, and restart only after admission/drain checks.
Keep the previous immutable image and compose for rollback. Never restore the
old database over subsequent user writes.

Muninn LiteLLM source/config/key policy lives in selfhosted/litellm/scripts.
The dedicated muninn-local-gateway Spark key limits eight active requests;
this bounds this gateway path, not unrelated direct Spark clients. The previous
shared title key is preserved. qwen38 is unavailable while its engine is absent;
Flash Next remains an explicit distinct model.

## Rebase onto upstream v0.5.69 (2026-09-08)

The patch stack now sits on upstream `eb712ca8` (v0.5.69) as branch
`dsh/v0.5.69`, combining the gateway reliability work with the dashboard
live-model-catalog fix. Conflicts resolved in favour of keeping both sides:
`[1m]` context-marker stripping alongside request-id propagation in
`src/sse/handlers/chat.js`, upstream's `providerSessionId`/`clientTool`
executor arguments alongside the cancellation signal in
`open-sse/handlers/chatCore.js`, and the fetch lock key alongside the typed
`EMPTY_EXTRACTION` return in `src/sse/handlers/fetch.js`. The composed
execution signal is now optional-safe because upstream stream controllers may
carry no signal.

Full suite versus plain v0.5.69: no pass→fail regressions (2113 passing here
against 2070 upstream, identical 114 pre-existing failures).

Release image `local/9router:dsh-cc1dcbdd`
(`sha256:6ed975cc5bf24abc45d6577b4e6bc9c2ba89fc30ed2303a971eee6229a803d5f`),
built from `Dockerfile.dsh` regenerated against upstream's current Dockerfile.
Staged and activated through Coolify with rollback record
`~/.local/state/dsh-gateway-releases/20260908T095312Z/release.json`
(previous image `local/9router:dsh-9a8efd1a`).

## Codex quota recognition (2026-09-08)

Three fixes for Codex quota handling, branch `dsh/codex-quota-families`:

1. Quota windows are classified by `limit_window_seconds` rather than by their
   slot in OpenAI's payload. Pro accounts report the 7-day window in
   `primary_window` with a null secondary, so slot-based labelling rendered it
   as "5h" and showed no weekly bar. Windows now carry `windowSeconds`, and the
   handler also parses `model_usage`, `applicable_available_count` and
   `spend_control`.
2. Rate-limit locks are keyed by quota family (`codex:normal` / `:spark` /
   `:review`) via `resolveQuotaScope`, opted into by `quotaScope: "family"` in
   the registry. Every other provider still locks per model id.
3. Auto-ping selects the shortest warmable window instead of a fixed `session`
   key, and skips accounts with nothing sub-daily to warm.

Full suite: 2162 passing / 114 pre-existing failures, no pass→fail regressions
against either plain v0.5.69 or the previous release. Provider, alias and OAuth
baselines byte-for-byte equal.
