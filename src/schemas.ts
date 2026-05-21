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

// --- Generation tools (1:1 with the API) -----------------------------------

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

// --- QoL utility tools (no credits consumed) --------------------------------

export const previewImageShape = {
  url: z.url().describe('Public URL of the image to preview (e.g., a generation output URL).'),
  open: z
    .boolean()
    .optional()
    .describe('Also open the image in the default browser, if a display is available. Default false.'),
};

export const saveImageShape = {
  url: z.url().describe('Public URL of the image to download.'),
  filename: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe('Optional filename (extension inferred from the content type if omitted).'),
  dir: z
    .string()
    .min(1)
    .optional()
    .describe('Optional target directory. Defaults to MYARCHITECTAI_DOWNLOAD_DIR (or ./renders).'),
};

export const saveImageOutputShape = {
  path: z.string().describe('Absolute path the image was saved to.'),
  bytes: z.number().describe('Size of the saved file in bytes.'),
  mimeType: z.string().describe('Content type of the saved image.'),
};

export const validateImageUrlShape = {
  url: z.url().describe('URL to check (via HEAD) for reachability and image content-type before using it as input.'),
};

export const validateUrlOutputShape = {
  ok: z.boolean().describe('Whether the URL responded successfully.'),
  status: z.number().describe('HTTP status code (0 if unreachable).'),
  contentType: z.string().nullable().describe('Reported content type, if any.'),
  isImage: z.boolean().describe('Whether the content type is an image.'),
  bytes: z.number().nullable().describe('Reported content length in bytes, if any.'),
};

export const listRecentShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('How many recent generations to return (default 10).'),
};

const generationRecordSchema = z.object({
  id: z.number(),
  tool: z.string(),
  createdAt: z.string(),
  output: z.array(z.string()),
  cost: z.number(),
  balance: z.number(),
});

export const listRecentOutputShape = {
  generations: z.array(generationRecordSchema).describe('Recent generations, most recent first.'),
};

export const usageOutputShape = {
  totalGenerations: z.number().describe('Number of generations recorded this session.'),
  totalCost: z.number().describe('Total credits spent this session.'),
  lastKnownBalance: z.number().nullable().describe('Balance after the most recent generation, or null if none.'),
  byTool: z
    .record(z.string(), z.object({ count: z.number(), cost: z.number() }))
    .describe('Per-tool breakdown of count and cost.'),
  since: z.string().nullable().describe('Timestamp of the first recorded generation, or null.'),
};
