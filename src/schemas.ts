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

const imageFormat = z
  .enum(['webp', 'jpg', 'png', 'avif'])
  .describe('Output image format: webp, jpg, png, or avif.');

const textToImageFormat = z
  .enum(['png', 'jpg', 'webp'])
  .describe('Output image format: png, jpg, or webp (avif is not supported for text-to-image).');

const prompt = z.string();
const negativePrompt = z
  .string()
  .describe('Optional text describing elements to exclude from the output.');

// --- Generation tools (1:1 with the API) -----------------------------------

export const renderExteriorShape = {
  image: z
    .url()
    .describe(
      'URL of the source image — a sketch, line drawing, 3D/CAD model screenshot, or photo. Either a public HTTPS URL reachable by MyArchitectAI, or an inline data:image/<mime>;base64,<payload> URI for a local file.',
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
      'URL of the source interior image — a sketch, line drawing, 3D/CAD model screenshot, or photo. Either a public HTTPS URL reachable by MyArchitectAI, or an inline data:image/<mime>;base64,<payload> URI for a local file.',
    ),
  outputFormat: imageFormat,
  prompt: prompt
    .optional()
    .describe('Optional prompt to steer the interior render (furnishing, materials, lighting, style).'),
};

export const styleTransferShape = {
  image: z
    .url()
    .describe(
      'URL of the source architectural image to restyle — a public HTTPS URL reachable by MyArchitectAI, or an inline data:image/<mime>;base64,<payload> URI for a local file.',
    ),
  referenceImage: z
    .url()
    .describe(
      'URL of the style reference image whose look is transferred onto the source — a public HTTPS URL reachable by MyArchitectAI, or an inline data:image/<mime>;base64,<payload> URI for a local file.',
    ),
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
    .describe(
      'Source image to upscale to 4K: a public HTTPS URL or an inline data:image/<mime>;base64,<payload> URI.',
    ),
  outputFormat: textToImageFormat.optional().describe('Output image format. Defaults to jpg if omitted.'),
};

export const upscaleShape = {
  ...upscale4kShape,
  targetResolution: z.enum(['4k', '8k']).optional().describe('Resolution on the longer side; defaults to 4k. At 8k use jpg or webp, not png.'),
};

export const upscaleSchema = z.object(upscaleShape).refine(
  (args) => args.targetResolution !== '8k' || args.outputFormat !== 'png',
  { message: 'PNG output is unavailable at 8K. Use jpg or webp.', path: ['outputFormat'] },
);

export const autoPromptShape = { image: renderExteriorShape.image };

export const editByPromptShape = {
  image: renderExteriorShape.image,
  prompt: prompt.describe('Natural-language instruction describing the edit.'),
  referenceImage: styleTransferShape.referenceImage.optional().describe('Optional reference image URL or image data URI. Refer to it as "attached image" in the prompt.'),
};

export const changeTexturesSchema = z.object({
  image: renderExteriorShape.image,
  mask: z.string().min(1).describe('Mask URL or base64 image: white marks surfaces to change; black preserves them.'),
  referenceImage: styleTransferShape.referenceImage.optional(),
  prompt: prompt.optional().describe('Desired texture; provide exactly one of prompt or referenceImage.'),
}).refine(
  (args) => (args.prompt !== undefined) !== (args.referenceImage !== undefined),
  { message: 'Provide exactly one of prompt or referenceImage.' },
);

export const setAtmosphereSchema = z.object({
  image: renderExteriorShape.image,
  sceneType: z.enum(['interior', 'exterior']),
  lighting: z.enum(['midday_light', 'golden_light', 'blue_hour_light', 'ambient_light', 'warm_lamps', 'dimmed_mood']).optional().describe('Required for interior scenes; do not send exterior fields.'),
  timeOfDay: z.enum(['early_morning', 'midday', 'overcast_day', 'golden_hour', 'sunset', 'blue_hour', 'night', 'starry_night', 'northern_lights', 'southern_lights']).optional(),
  season: z.enum(['spring', 'summer', 'autumn', 'winter']).optional(),
  weather: z.enum(['clear', 'overcast', 'rain', 'fog', 'snow']).optional(),
}).superRefine((args, ctx) => {
  const hasExterior = args.timeOfDay !== undefined || args.season !== undefined || args.weather !== undefined;
  if (args.sceneType === 'interior' && (args.lighting === undefined || hasExterior)) {
    ctx.addIssue({ code: 'custom', message: 'Interior mode requires lighting and rejects timeOfDay, season and weather.' });
  }
  if (args.sceneType === 'exterior' && (!hasExterior || args.lighting !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Exterior mode requires timeOfDay, season or weather and rejects lighting.' });
  }
});

export const animateShape = {
  startFrameUrl: renderExteriorShape.image,
  prompt: prompt.describe('Camera motion or transition to animate.'),
  endFrameUrl: renderExteriorShape.image.optional().describe('Optional end frame URL or image data URI for a transition.'),
};

/** Shared structured-output schema returned by every generation tool. */
export const generationOutputShape = {
  output: z.array(z.string()).describe('URLs of generated images, or a video URL for animate.'),
  balance: z.number().describe('Remaining account balance in USD after this request.'),
  cost: z.number().describe('Cost charged in USD for this request.'),
  requestId: z.number().int().optional().describe('API request ID for support and request-log lookup.'),
};

export const autoPromptOutputShape = {
  ...generationOutputShape,
  output: z.string().describe('Generated render prompt as plain text, not a URL.'),
};

export const balanceOutputShape = {
  balance: z.number().describe('Current account balance in USD.'),
};

// --- QoL utility tools (no credits consumed) --------------------------------

export const previewImageShape = {
  url: z
    .string()
    .min(1)
    .describe(
      'Image to preview: a public HTTPS URL (e.g. a generation output), an inline data:image/<mime>;base64,<payload> URI, or a local file path (absolute, ~, or file://).',
    ),
  open: z
    .boolean()
    .optional()
    .describe('Also open the image in the default browser, if a display is available. Default false.'),
};

export const saveImageShape = {
  url: z
    .string()
    .min(1)
    .describe(
      'Image to save: a public HTTPS URL, an inline data:image/<mime>;base64,<payload> URI, or a local file path (absolute, ~, or file://).',
    ),
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
  requestId: z.number().int().optional(),
  outputType: z.enum(['image', 'video', 'text']).optional(),
});

export const listRecentOutputShape = {
  generations: z.array(generationRecordSchema).describe('Recent generations, most recent first.'),
};

export const usageOutputShape = {
  totalGenerations: z.number().describe('Number of successful generations recorded this session.'),
  failedGenerations: z
    .number()
    .describe('Number of generations that failed with an API/validation error this session.'),
  totalCost: z.number().describe('Total USD spent this session.'),
  lastKnownBalance: z
    .number()
    .nullable()
    .describe('Most recent balance reported by the API (from a successful or failed call), or null if none yet.'),
  byTool: z
    .record(z.string(), z.object({ count: z.number(), cost: z.number() }))
    .describe('Per-tool breakdown of count and cost.'),
  since: z.string().nullable().describe('Timestamp of the first recorded generation, or null.'),
  apiKeyFingerprint: z
    .string()
    .describe(
      'Masked fingerprint (leading ellipsis + last 4 characters) of the active API key, so you can confirm which key is in use without exposing the full secret.',
    ),
};
