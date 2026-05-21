---
name: compare-renders
description: Compare two or more architectural images (source vs render, render vs 4K upscale, or competing style variants) and assess differences in fidelity, materials, lighting, geometry, color, detail, and artifacts. Use when the user asks to compare renders, spot what changed, check specific features, or decide which option is better.
argument-hint: [image-url-a] [image-url-b]
allowed-tools: mcp__myarchitectai__preview_image
---

# Compare architectural images

You are comparing two (or more) images — typically a source and its render, a render and its 4K upscale, or competing style variants. You are multimodal: load the images and judge them by actually looking, not by guessing from URLs or filenames.

## Steps

1. Load each image into context with `mcp__myarchitectai__preview_image` (one call per URL). This consumes no MyArchitectAI credits and returns the image inline so you can see it.
2. Compare across these dimensions:
   - **Fidelity to source** — is the original geometry, layout, and structure preserved?
   - **Materials & textures** — surfaces, finishes, realism.
   - **Lighting & shadows** — direction, softness, time of day, consistency.
   - **Color & tone** — palette, white balance, saturation.
   - **Proportions & perspective** — scale, vanishing points, distortion.
   - **Detail & sharpness** — resolution and fine detail (especially for upscales).
   - **Artifacts** — warping, hallucinated elements, seams, noise.
3. If the user named specific features to check (windows, roofline, landscaping, a sign, etc.), evaluate those explicitly.

## Output

- A short per-dimension comparison (A vs B) as a compact table or bullets.
- The notable differences and any artifacts you can see.
- A clear verdict: which image better serves the user's stated goal, or a precise summary of what changed.

Stay grounded in what is actually visible in the images. If an image fails to load, say so and ask for a valid public URL.
