# OpenAI Responses WebSocket

Enabled by default on `local`, `dev`, and `beta`. On `latest` and `prod`, set `OC2_EXPERIMENTAL_WEBSOCKETS=true`.

## Flow

1. A streamed `POST /responses` request arrives.
2. If it has no `session-id` or `x-session-affinity` header, use HTTP.
3. Title requests use HTTP.
4. If that session's socket is busy or already in fallback mode, use HTTP.
5. Otherwise, reuse its open socket or open a new one.
6. Send `response.create` and return WebSocket events as SSE.

## Lifetime

- Connect timeout: 15 seconds.
- Completed, unused sockets are removed from the pool after 5 minutes.
- Active responses are limited to 20 minutes without a provider event.
- Active sockets are pinged every 30 seconds and invalidated if no pong arrives within 90 seconds.
- After a completed response, keep the socket for reuse.
- Reuse a socket for up to 55 minutes, then replace it on the next request.

## Retries

- After an initial WebSocket failure, allow a failure budget of 5 additional failures, then use HTTP for that session until it is removed or the pool closes.
- `websocket_connection_limit_reached` consumes the same failure budget and HTTP fallback.
- If a WebSocket fails after its first event, fail it as retryable rather than replaying partial output in transport.
- Abort or cancel closes the socket.

## Next Steps

- `previous_response_id` continuation.
- Optional second WebSocket for concurrent requests in one session. Currently these use HTTP.
