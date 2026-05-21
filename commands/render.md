---
name: render
description: Guided MyArchitectAI render — validate an input image URL, generate an exterior or interior render, then preview and save the result.
argument-hint: [image-url] [exterior|interior] [optional style notes]
allowed-tools: mcp__myarchitectai__validate_image_url mcp__myarchitectai__render_exterior mcp__myarchitectai__render_interior mcp__myarchitectai__preview_image mcp__myarchitectai__save_image mcp__myarchitectai__usage_summary
---

Run a complete render workflow for: $ARGUMENTS

1. **Parse** the arguments: an image URL, an optional kind (`exterior` or `interior`, default `exterior`), and optional style notes used to build the prompt.
2. **Validate** the URL first with `validate_image_url`. If it is not a reachable image, stop and report the problem — do **not** spend a credit.
3. **Render** with `render_exterior` (or `render_interior` if requested) using `outputFormat: "jpg"`, passing a `prompt` built from the style notes when provided.
4. **Preview** the result with `preview_image` so the user can see it.
5. **Save** the result with `save_image`.
6. Report the **cost and remaining balance** from the render result.

If any step fails, report the error clearly and stop before spending further credits.
