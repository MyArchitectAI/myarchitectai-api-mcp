---
"@myarchitectai/mcp": patch
---

Image fields in `render_exterior`, `render_interior`, `style_transfer`, and `upscale_4k` tools now document support for inline base64 data URIs (`data:image/<mime>;base64,<payload>`) in addition to public HTTPS URLs, so local images can be passed directly without hosting them remotely.
