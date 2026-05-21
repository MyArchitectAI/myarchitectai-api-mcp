/**
 * Registers all tools on an {@link McpServer}:
 *  - five generation tools mapped 1:1 to the MyArchitectAI API (each records
 *    its result to the session store), and
 *  - five QoL tools (preview, save, validate, usage, recent) that consume no
 *    credits.
 *
 * Generation handlers forward their validated arguments (which map 1:1 to the
 * API's JSON body) to {@link MyArchitectAIClient.generate}; `JSON.stringify`
 * drops absent optional fields, so the validated args are sent as-is.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import type { GenerationResult, MyArchitectAIClient } from './client.js';
import { MediaService, openInBrowser } from './media.js';
import type { SessionStore } from './session.js';
import { MyArchitectAIError } from './errors.js';
import {
  generationOutputShape,
  listRecentOutputShape,
  listRecentShape,
  previewImageShape,
  renderExteriorShape,
  renderInteriorShape,
  saveImageOutputShape,
  saveImageShape,
  styleTransferShape,
  textToImageShape,
  upscale4kShape,
  usageOutputShape,
  validateImageUrlShape,
  validateUrlOutputShape,
} from './schemas.js';

export interface ToolDeps {
  client: MyArchitectAIClient;
  session: SessionStore;
  media: MediaService;
  config: Config;
}

const ENDPOINT = {
  renderExterior: '/render/exterior',
  renderInterior: '/render/interior',
  styleTransfer: '/style-transfer',
  textToImage: '/text-to-image',
  upscale4k: '/upscale-4k',
} as const;

/** Generation tools touch an external system, charge credits, and aren't idempotent. */
const GENERATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const TOOL_NAMES = [
  'render_exterior',
  'render_interior',
  'style_transfer',
  'text_to_image',
  'upscale_4k',
  'preview_image',
  'save_image',
  'validate_image_url',
  'usage_summary',
  'list_recent_generations',
] as const;

export function registerTools(server: McpServer, deps: ToolDeps): string[] {
  registerGenerationTools(server, deps);
  registerQolTools(server, deps);
  return [...TOOL_NAMES];
}

function registerGenerationTools(server: McpServer, deps: ToolDeps): void {
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
      annotations: GENERATION_ANNOTATIONS,
    },
    async (args) => generate(deps, ENDPOINT.renderExterior, 'render_exterior', 'Exterior render', args),
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
      annotations: GENERATION_ANNOTATIONS,
    },
    async (args) => generate(deps, ENDPOINT.renderInterior, 'render_interior', 'Interior render', args),
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
      annotations: GENERATION_ANNOTATIONS,
    },
    async (args) => generate(deps, ENDPOINT.styleTransfer, 'style_transfer', 'Style transfer', args),
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
      annotations: GENERATION_ANNOTATIONS,
    },
    async (args) => generate(deps, ENDPOINT.textToImage, 'text_to_image', 'Text-to-image', args),
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
      annotations: GENERATION_ANNOTATIONS,
    },
    async (args) => generate(deps, ENDPOINT.upscale4k, 'upscale_4k', 'Upscale to 4K', args),
  );
}

function registerQolTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'preview_image',
    {
      title: 'Preview Image',
      description:
        'Fetch an image by URL and return it inline so you (the agent) and GUI clients can actually see it — ' +
        'useful for inspecting a generation result before continuing. Optionally also opens it in the default ' +
        'browser when a display is available. Consumes no MyArchitectAI credits.',
      inputSchema: previewImageShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, open }) => {
      try {
        const fetched = await deps.media.fetchForPreview(url);
        const opened = open === true ? openInBrowser(url) : false;
        const note = openNote(open === true, opened);
        if (fetched.tooLarge) {
          return text(
            `Image is ${formatBytes(fetched.bytes)} — too large to embed inline ` +
              `(limit ${formatBytes(deps.config.maxPreviewBytes)}). Open it directly:\n${url}${note}`,
          );
        }
        return {
          content: [
            { type: 'text', text: `Preview of ${url} (${formatBytes(fetched.bytes)}, ${fetched.mimeType})${note}` },
            { type: 'image', data: fetched.base64, mimeType: fetched.mimeType },
          ],
        };
      } catch (err) {
        return formatError('Preview', err);
      }
    },
  );

  server.registerTool(
    'save_image',
    {
      title: 'Save Image',
      description:
        'Download an image URL to local disk (defaults to the configured download directory) and return the ' +
        'saved file path. Generation output URLs are public but may expire, so saving keeps a permanent copy. ' +
        'Consumes no MyArchitectAI credits.',
      inputSchema: saveImageShape,
      outputSchema: saveImageOutputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ url, filename, dir }) => {
      try {
        const saved = await deps.media.save(url, {
          dir: dir ?? deps.config.downloadDir,
          ...(filename !== undefined ? { filename } : {}),
        });
        return {
          content: [{ type: 'text', text: `Saved ${formatBytes(saved.bytes)} (${saved.mimeType}) to ${saved.path}` }],
          structuredContent: { path: saved.path, bytes: saved.bytes, mimeType: saved.mimeType },
        };
      } catch (err) {
        return formatError('Save', err);
      }
    },
  );

  server.registerTool(
    'validate_image_url',
    {
      title: 'Validate Image URL',
      description:
        'HEAD-check that a URL is reachable and returns an image, before using it as a render input (which would ' +
        'otherwise spend a credit on a request guaranteed to fail). Consumes no MyArchitectAI credits.',
      inputSchema: validateImageUrlShape,
      outputSchema: validateUrlOutputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        const check = await deps.media.check(url);
        const verdict = check.ok && check.isImage
          ? 'OK — reachable image.'
          : check.ok
            ? `Reachable, but not an image (content-type: ${check.contentType ?? 'unknown'}).`
            : `Not reachable (status ${check.status}${check.reason ? `: ${check.reason}` : ''}).`;
        return {
          content: [{ type: 'text', text: `${url}\n${verdict}` }],
          structuredContent: {
            ok: check.ok,
            status: check.status,
            contentType: check.contentType,
            isImage: check.isImage,
            bytes: check.contentLength,
          },
        };
      } catch (err) {
        return formatError('Validate', err);
      }
    },
  );

  server.registerTool(
    'usage_summary',
    {
      title: 'Usage Summary',
      description:
        "Report this session's MyArchitectAI usage: number of generations, total credits spent, the last known " +
        'balance (from the most recent generation — no paid call), and a per-tool breakdown. Consumes no credits.',
      outputSchema: usageOutputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const summary = deps.session.summary();
      const lines = [
        `Generations this session: ${summary.totalGenerations}`,
        `Total cost: ${formatNumber(summary.totalCost)} credits`,
        `Last known balance: ${summary.lastKnownBalance === null ? 'unknown (no generations yet)' : `${formatNumber(summary.lastKnownBalance)} credits`}`,
      ];
      for (const [tool, value] of Object.entries(summary.byTool)) {
        lines.push(`  - ${tool}: ${value.count}× (${formatNumber(value.cost)} credits)`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          totalGenerations: summary.totalGenerations,
          totalCost: summary.totalCost,
          lastKnownBalance: summary.lastKnownBalance,
          byTool: summary.byTool,
          since: summary.since,
        },
      };
    },
  );

  server.registerTool(
    'list_recent_generations',
    {
      title: 'List Recent Generations',
      description:
        'List recent generations from this session (tool, time, output URLs, cost, balance) so you can re-preview ' +
        'or save an earlier result without regenerating it — and without spending credits.',
      inputSchema: listRecentShape,
      outputSchema: listRecentOutputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      const generations = deps.session.recent(limit ?? 10);
      const lines = generations.length
        ? generations.map(
            (record) =>
              `#${record.id} ${record.tool} @ ${record.createdAt} — ${record.output.length} image(s), ` +
              `cost ${formatNumber(record.cost)} — ${record.output.join(', ')}`,
          )
        : ['No generations recorded yet this session.'];
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { generations } };
    },
  );
}

async function generate(
  deps: ToolDeps,
  path: string,
  toolName: string,
  label: string,
  body: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const result = await deps.client.generate(path, body);
    await deps.session.record({
      tool: toolName,
      output: result.output,
      cost: result.cost,
      balance: result.balance,
    });
    return formatSuccess(label, result);
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

    const detail = meta.length > 0 ? `\n\n(${meta.join(' · ')})` : '';
    return { content: [{ type: 'text', text: `${label} failed: ${err.message}${detail}` }], isError: true };
  }

  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `${label} failed: ${message}` }], isError: true };
}

function text(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }] };
}

function openNote(requested: boolean, opened: boolean): string {
  if (!requested) return '';
  return opened ? ' — opened in browser.' : ' — no display detected, not opened.';
}

/** Render a credit amount without floating-point noise or trailing zeros. */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  return (Math.round(value * 1e4) / 1e4).toString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
