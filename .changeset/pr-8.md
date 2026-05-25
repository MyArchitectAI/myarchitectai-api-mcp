---
"@myarchitectai/mcp": patch
---

Fixed: when the MyArchitectAI API returns HTTP 200 with an error body, the client now throws a `RequestError` containing the actual error message, balance, and cost — instead of an `UpstreamError` with a generic "malformed success response" message.
