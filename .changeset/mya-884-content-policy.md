---
"@myarchitectai/mcp": patch
---

Preserve public content safety error codes, stable messages, billing metadata and request IDs in direct and hosted MCP results. Content policy violations and unavailable safety checks never trigger automatic retries, including HTTP 429/502 responses.

Include retained policy charges in session spend without adding successful generation counts or output history. Persist charges, failure counts and balance alongside successful history, while keeping legacy state files readable.
