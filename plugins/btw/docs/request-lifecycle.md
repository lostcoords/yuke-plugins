# Native side-request lifecycle review

Historical maintainer reference, not an installation requirement. The plugin depends on
Yuke's public `sideRequest` API, not the internal implementation paths discussed below.

Reviewed 2026-10-31 against `lostcoords/yuke` revision
`68827951f253f0a0f7240fba6d40ac27b70308b7`, matching the installed
`yuke 0.0.1-nightly.20261030+68827951f253`.

## Conclusion

The plugin uses the appropriate native path: `RoundBeforeEvent.sideRequest`.
It does **not** create/open a second session, fork a session, acquire a session handle,
append session events, or start a tool-execution loop. No missing request cleanup or
additional session ownership was found in this path. This is source review plus behavior
checks, not a heap-profile or a proof that the entire application is leak-free.

## Rust ownership and cleanup

Source links are pinned to the reviewed revision:

- [`crates/js/src/session.rs`](https://github.com/lostcoords/yuke/blob/68827951f253f0a0f7240fba6d40ac27b70308b7/crates/js/src/session.rs#L223-L238):
  `ScriptHooks::natives` makes an owned `Round` snapshot in an `Arc`. The snapshot contains
  the model, system prompt, tools, settings, parent session ID, and context—not a new
  `ScriptSession` or a live session handle.
- [`crates/js/src/native/ai.rs`](https://github.com/lostcoords/yuke/blob/68827951f253f0a0f7240fba6d40ac27b70308b7/crates/js/src/native/ai.rs#L176-L211):
  the native closure holds that snapshot; each invocation makes an owned `SideRequest`
  and runs it as a cancellable `Operation`. Those per-request owned values are released
  when the future ends/drops. The retained closure still owns its snapshot separately.
- [`crates/yuke/src/app/models.rs`](https://github.com/lostcoords/yuke/blob/68827951f253f0a0f7240fba6d40ac27b70308b7/crates/yuke/src/app/models.rs#L44-L96):
  `PluginModels::side_request` appends the side prompt to local blocks. The parent ID is
  used as a cache-routing key and to read existing media, not to open a session. It calls
  `Driver::request`, returning only answer text, finish reason, and usage. It performs no
  store writes or tool execution. The cache marker remains before the appended prompt.
- [`crates/engine/src/drive.rs`](https://github.com/lostcoords/yuke/blob/68827951f253f0a0f7240fba6d40ac27b70308b7/crates/engine/src/drive.rs#L323-L405):
  the driver races credential retrieval, HTTP opening, stream reads, and retry sleeps
  against cancellation. Cancellation during streaming consumes `reply.cancel()`;
  ordinary success/failure also consumes/drops the reply and request-local state.
- [`crates/http/src/lib.rs`](https://github.com/lostcoords/yuke/blob/68827951f253f0a0f7240fba6d40ac27b70308b7/crates/http/src/lib.rs#L496-L516):
  the HTTP body owns its connection, incoming body, and read timer. Dropping the body
  closes its connection; this is not a detached per-request connection task that the
  plugin must join separately.
- [`crates/js/src/models.rs`](https://github.com/lostcoords/yuke/blob/68827951f253f0a0f7240fba6d40ac27b70308b7/crates/js/src/models.rs#L94-L139):
  `OnConsumer::run` awaits the Tokio task and uses a cancellation-token drop guard.
  If the JavaScript wait is dropped, including runtime shutdown, the guard cancels the
  consumer-side request. Normal completion disarms it after the task has ended.

The JavaScript bridge's `underSignal` removes its abort step in a `finally` block.
`AbortSignal.any` uses weak dependency links and retains an active dependent while it
has abort steps/listeners; removing the request's step releases that active retention.
The plugin combines the overlay/caller signal with the **session** signal, deliberately
not the main turn's signal. Closing the panel or parent session cancels the side request;
cancelling only the main turn does not.

## Intentional retention and limits

- The plugin keeps **one latest round snapshot per open parent session**. Replacing a
  round drops the map's previous reference; closing the session deletes its map entry.
  Collection/final release of unreachable JavaScript/native closures is subject to GC.
  An in-flight request can independently keep its own request data until it settles.
- Closing a panel does not clear the parent session's latest snapshot. That retained
  context enables another side question without reconstructing the prompt. It can be
  substantial for a long conversation, but it is not one accumulated snapshot per ask.
- Each active request temporarily clones context/tools/settings and constructs encoded
  request/response buffers. Concurrent panels/requests increase transient memory use.
- The view retains its displayed answer and any next draft while open. Completed text
  history remains on disk by design; it is not replayed into model requests.
- `Driver::send` supplies no overall request deadline. The installed provider HTTP client
  uses the default **300-second idle timeout**, with native retry policy and response-size
  limits (64 MiB response-body limit by default). These are not a short `/btw` wall-clock
  timeout. A slow/trickling provider can keep an in-flight request alive; Escape remains
  the explicit cancellation action. No timeout/retry policy was changed in this plugin.

## Executed checks

- Plugin `yuke:test` tests cover completion, model failure, tool-call suppression, repeated
  questions against the native prefix, side cancellation, parent-session cancellation,
  main-turn cancellation independence, and removal of cached request handles at close.
- The upstream `crates/yuke/tests/host/hooks/side-request.test.ts` suite ran with the
  installed binary: **4 passed** (request/options, context slicing, abort, failure).
- The isolated real-TUI probe checks actual HTTP-body closure when Escape cancels a
  stalled side response, with the main response still blocked and no incomplete history
  saved. Other scenarios compare exact outbound cache prefixes and restart persistence.

No upstream Rust source was modified. No Rust rebuild, allocator instrumentation,
long-running RSS benchmark, or live-provider/billing test was performed.
