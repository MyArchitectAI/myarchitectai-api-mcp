/**
 * Registers the MyArchitectAI tools on an {@link McpServer}.
 *
 * Every endpoint shares the same response contract, so each handler simply
 * forwards its validated arguments (which map 1:1 to the API's JSON body) to
 * {@link MyArchitectAIClient.generate} and formats the result. `JSON.stringify`
 * drops absent optional fields, so the validated args can be sent as-is.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GenerationResult, MyArchitectAIClient } from './client.js';
import { MyArchitectAIError } from './errors.js';
import {
  generationOutputShape,
  renderExteriorShape,
  renderInteriorShape,
  styleTransferShape,
  textToImageShape,
  upscale4kShape,
} from './schemas.js';

const ENDPOINT = {
  renderExterior: '/render/exterior',
  renderInterior: '/render/interior',
  styleTransfer: '/style-transfer',
  textToImage: '/text-to-image',
  upscale4k: '/upscale-4k',
} as const;

/** All generation tools touch an external system, charge credits, and are not idempotent. */
const ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Register all tools and return their names.
 */
export function registerTools(server: McpServer, client: MyArchitectAIClient): string[] {
  server.registerTool(
    'render_exterior',
    {
      title: 'Render Exterior',
      description:
        'Generate a photorealistic EXTERIOR architectural render from a source image (sketch, line drawing, ' +
        '3D/CAD model screenshot, or photo provided as a public URL). Optionally steer the result with a text ' +
        'prompt. Runs synchronously (typically under ~10s). Returns the generated image URL(s) plus the credit ' +
        'cost and remaining balance.',
      inputSchema: renderExteriorShape,
      outputSchema: generationOutputShape,
      annotations: ANNOTATIONS,
    },
    async (args) => execute(client, ENDPOINT.renderExterior, 'Exterior render', args),
  );

  server.registerTool(
    'render_interior',
    {
      title: 'Render Interior',
      description:
        'Generate a photorealistic INTERIOR architectural render from a source image (sketch, line drawing, ' +
        '3D/CAD model screenshot, or photo provided as a public URL). Optionally steer the result with a text ' +
        'prompt. Runs synchronously (typically under ~10s). Returns the generated image URL(s) plus the credit ' +
        'cost and remaining balance.',
      inputSchema: renderInteriorShape,
      outputSchema: generationOutputShape,
      annotations: ANNOTATIONS,
    },
    async (args) => execute(client, ENDPOINT.renderInterior, 'Interior render', args),
  );

  server.registerTool(
    'style_transfer',
    {
      title: 'Style Transfer',
      description:
        'Transfer the visual style of a reference image onto a source architectural image. Provide `image` ' +
        '(the source) and `referenceImage` (the look to copy) as public URLs, and control intensity with ' +
        '`styleTransferStrength` (0–1). Optional `prompt`/`negativePrompt`. Returns the generated image URL(s) ' +
        'plus the credit cost and remaining balance.',
      inputSchema: styleTransferShape,
      outputSchema: generationOutputShape,
      annotations: ANNOTATIONS,
    },
    async (args) => execute(client, ENDPOINT.styleTransfer, 'Style transfer', args),
  );

  server.registerTool(
    'text_to_image',
    {
      title: 'Text to Image',
      description:
        'Generate an architectural image purely from a text `prompt` (no source image). Specify `outputWidth` ' +
        'and `outputHeight` in pixels (128–2048) and `outputFormat` (png/jpg/webp — avif is not supported here). ' +
        'Use `negativePrompt` to exclude unwanted elements. Returns the generated image URL(s) plus the credit ' +
        'cost and remaining balance.',
      inputSchema: textToImageShape,
      outputSchema: generationOutputShape,
      annotations: ANNOTATIONS,
    },
    async (args) => execute(client, ENDPOINT.textToImage, 'Text-to-image', args),
  );

  server.registerTool(
    'upscale_4k',
    {
      title: 'Upscale to 4K',
      description:
        'Upscale an existing image to higher resolution (up to 4K/8K) while preserving detail and sharpness. ' +
        'Provide the source `image` URL (accepts inputs up to 2K). Optional `outputFormat` (defaults to jpg). ' +
        'Returns the upscaled image URL(s) plus the credit cost and remaining balance.',
      inputSchema: upscale4kShape,
      outputSchema: generationOutputShape,
      annotations: ANNOTATIONS,
    },
    async (args) => execute(client, ENDPOINT.upscale4k, 'Upscale to 4K', args),
  );

  return ['render_exterior', 'render_interior', 'style_transfer', 'text_to_image', 'upscale_4k'];
}

async function execute(
  client: MyArchitectAIClient,
  path: string,
  label: string,
  body: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    return formatSuccess(label, await client.generate(path, body));
  } catch (err) {
    return formatError(label, err);
  }
}

function formatSuccess(label: string, result: GenerationResult): CallToolResult {
  const { output, balance, cost } = result;
  const count = output.length;
  const lines = [
    `${label} complete — ${count} image${count === 1 ? '' : 's'} generated.`,
    '',
    ...output.map((url, index) => `${index + 1}. ${url}`),
    '',
    `Cost: ${formatNumber(cost)} credits · Remaining balance: ${formatNumber(balance)} credits`,
  ];
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: { output, balance, cost },
  };
}

function formatError(label: string, err: unknown): CallToolResult {
  if (err instanceof MyArchitectAIError) {
    const meta: string[] = [];
    if (err.status !== undefined) meta.push(`HTTP ${err.status}`);
    if (typeof err.balance === 'number') meta.push(`balance ${formatNumber(err.balance)}`);
    if (typeof err.cost === 'number') meta.push(`cost ${formatNumber(err.cost)}`);

    const text =
      `${label} failed: ${err.message}` + (meta.length > 0 ? `\n\n(${meta.join(' · ')})` : '');
    return { content: [{ type: 'text', text }], isError: true };
  }

  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `${label} failed: ${message}` }], isError: true };
}

/** Render a credit amount without floating-point noise or trailing zeros. */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  return (Math.round(value * 1e4) / 1e4).toString();
}
