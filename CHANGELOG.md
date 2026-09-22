# @myarchitectai/mcp

## 0.2.0

### Minor Changes

- b37499a: Add auto prompts, image editing, texture changes, atmosphere controls, animation, 4K/8K upscaling and live balance lookup. Align input validation, USD accounting and request IDs with the current API, and keep timeouts active through streamed responses.
- d245c92: The `usage_summary` tool now reports a `failedGenerations` count alongside successful generations, and `lastKnownBalance` is updated from API error responses as well as successful calls.
- 8b42207: The `preview_image` and `save_image` tools now accept inline `data:` URIs and local file paths (absolute, `~`-prefixed, or `file://`) in addition to public HTTPS URLs. Images from these sources are loaded without any network request.
- d04dbc7: The `usage_summary` tool now includes a masked API key fingerprint (e.g. `…6789`) in both its structured output and human-readable text, so you can confirm which key is active without exposing the full secret.

### Patch Changes

- 66473ed: Fixed: when the MyArchitectAI API returns HTTP 200 with an error body, the client now throws a `RequestError` containing the actual error message, balance, and cost — instead of an `UpstreamError` with a generic "malformed success response" message.
- 5d7c6d1: Image fields in `render_exterior`, `render_interior`, `style_transfer`, and `upscale_4k` tools now document support for inline base64 data URIs (`data:image/<mime>;base64,<payload>`) in addition to public HTTPS URLs, so local images can be passed directly without hosting them remotely.
