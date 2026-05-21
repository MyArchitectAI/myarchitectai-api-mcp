/**
 * Zod input/output schemas for each tool, expressed as raw shapes so they can
 * be passed straight to `McpServer.registerTool`. Constraints mirror the
 * MyArchitectAI OpenAPI specification.
 *
 * Note: input image fields use `z.url()` to catch mistakes early, while the
 * output schema uses `z.string()` so a valid generation is never rejected on a
 * URL technicality from the upstream API.
 */

import { z } from 'zod';

const PROMPT_MAX = 2000;

const imageFormat = z
  .enum(['webp', 'jpg', 'png', 'avif'])
  .describe('Output image format: webp, jpg, png, or avif.');

const textToImageFormat = z
  .enum(['png', 'jpg', 'webp'])
  .describe('Output image format: png, jpg, or webp (avif is not supported for text-to-image).');

const prompt = z.string().min(1).max(PROMPT_MAX);
const negativePrompt = z
  .string()
  .min(1)
  .max(PROMPT_MAX)
  .describe('Optional text describing elements to exclude from the output.');

export const renderExteriorShape = {
  image: z
    .url()
    .describe(
      'Public URL of the source image — a sketch, line drawing, 3D/CAD model screenshot, or photo. Must be reachable by MyArchitectAI.',
    ),
  outputFormat: imageFormat,
  prompt: prompt
    .optional()
    .describe('Optional prompt to steer the exterior render (materials, time of day, surroundings, style).'),
};

export const renderInteriorShape = {
  image: z
    .url()
    .describe(
      'Public URL of the source interior image — a sketch, line drawing, 3D/CAD model screenshot, or photo. Must be reachable by MyArchitectAI.',
    ),
  outputFormat: imageFormat,
  prompt: prompt
    .optional()
    .describe('Optional prompt to steer the interior render (furnishing, materials, lighting, style).'),
};

export const styleTransferShape = {
  image: z.url().describe('Public URL of the source architectural image to restyle.'),
  referenceImage: z
    .url()
    .describe('Public URL of the style reference image whose look is transferred onto the source.'),
  outputFormat: imageFormat,
  prompt: prompt.optional().describe('Optional prompt to further guide the style transfer.'),
  negativePrompt: negativePrompt.optional(),
  styleTransferStrength: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('How strongly to apply the reference style: 0 = no effect, 1 = full transfer.'),
};

export const textToImageShape = {
  prompt: prompt.describe('Text description of the architectural image to generate.'),
  outputFormat: textToImageFormat,
  outputWidth: z.number().int().min(128).max(2048).describe('Output image width in pixels (128–2048).'),
  outputHeight: z.number().int().min(128).max(2048).describe('Output image height in pixels (128–2048).'),
  negativePrompt: negativePrompt.optional(),
};

export const upscale4kShape = {
  image: z
    .url()
    .describe('Public URL of the source image to upscale. Accepts inputs up to 2K; outputs up to 4K (or 8K).'),
  outputFormat: imageFormat.optional().describe('Output image format. Defaults to jpg if omitted.'),
};

/** Shared structured-output schema returned by every generation tool. */
export const generationOutputShape = {
  output: z.array(z.string()).describe('URLs of the generated image(s).'),
  balance: z.number().describe('Remaining account credit balance after this request.'),
  cost: z.number().describe('Credits charged for this request.'),
};
