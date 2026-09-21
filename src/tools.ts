/**
 * Registers all tools on an {@link McpServer}:
 *  - API operations mapped 1:1 to MyArchitectAI, with generation history, and
 *  - five utilities (preview, save, validate, usage, recent) without API charges.
 *
 * Generation handlers forward their validated arguments (which map 1:1 to the
 * API's JSON body) to {@link MyArchitectAIClient.generate}; `JSON.stringify`
 * drops absent optional fields, so the validated args are sent as-is.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { apiKeyFingerprint, type Config } from './config.js';
import type { GenerationResult, MyArchitectAIClient } from './client.js';
import { classifyImageInput, describeSource, MediaService, openInBrowser, resolveLocalPath } from './media.js';
import type { SessionStore } from './session.js';
import { MyArchitectAIError } from './errors.js';
import {
  animateShape,
  autoPromptShape,
  autoPromptOutputShape,
  balanceOutputShape,
  changeTexturesSchema,
  editByPromptShape,
  setAtmosphereSchema,
  upscaleSchema,
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

export const API_TOOL_ENDPOINTS = {
  render_exterior: '/render/exterior',
  render_interior: '/render/interior',
  style_transfer: '/style-transfer',
  text_to_image: '/text-to-image',
  upscale_4k: '/upscale-4k',
  auto_prompt: '/auto-prompt',
  edit_by_prompt: '/edit-by-prompt',
  change_textures: '/change-textures',
  set_atmosphere: '/set-atmosphere',
  animate: '/animate',
  upscale: '/upscale',
  balance: '/balance',
} as const;

/** Generation tools touch an external system, charge USD, and aren't idempotent. */
const GENERATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const TOOL_NAMES = [
  ...Object.keys(API_TOOL_ENDPOINTS),
  'preview_image', 'save_image', 'validate_image_url', 'usage_summary', 'list_recent_generations',
];

export function registerTools(server: McpServer, deps: ToolDeps): string[] {
  registerGenerationTools(server, deps);
  registerQolTools(server, deps);
  return [...TOOL_NAMES];
}

type GenerationTool = {
  name: Exclude<keyof typeof API_TOOL_ENDPOINTS, 'auto_prompt' | 'balance'>;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
};

function registerGenerationTools(server: McpServer, deps: ToolDeps): void {
  const tools: GenerationTool[] = [
    { name: 'render_exterior', title: 'Render Exterior', inputSchema: z.object(renderExteriorShape),
      description: 'Generate a photorealistic exterior render from a CAD export, sketch or photo. Optionally guide it with a prompt.' },
    { name: 'render_interior', title: 'Render Interior', inputSchema: z.object(renderInteriorShape),
      description: 'Generate a photorealistic interior render from a CAD export, sketch or photo. Optionally guide it with a prompt.' },
    { name: 'style_transfer', title: 'Style Transfer', inputSchema: z.object(styleTransferShape),
      description: 'Transfer a reference image style onto an architectural image, with optional prompt, negativePrompt and styleTransferStrength (0–1).' },
    { name: 'text_to_image', title: 'Text to Image', inputSchema: z.object(textToImageShape),
      description: 'Generate an architectural image from text. Choose width and height (128–2048 pixels) and png, jpg or webp format.' },
    { name: 'upscale_4k', title: 'Upscale to 4K (legacy)', inputSchema: z.object(upscale4kShape),
      description: 'Deprecated compatibility tool for 4K upscaling. Prefer upscale, which supports explicit 4k/8k targets. No avif output.' },
    { name: 'edit_by_prompt', title: 'Edit by Prompt', inputSchema: z.object(editByPromptShape),
      description: 'Edit an image with a natural-language instruction, optionally using an attached reference image.' },
    { name: 'change_textures', title: 'Change Textures', inputSchema: changeTexturesSchema,
      description: 'Retexture masked surfaces while preserving geometry. Mask white = change, black = keep. Provide exactly one of referenceImage or prompt.' },
    { name: 'set_atmosphere', title: 'Set Atmosphere', inputSchema: setAtmosphereSchema,
      description: 'Relight interiors or change exterior atmosphere. Interior requires lighting only. Exterior requires at least one of timeOfDay, season or weather and rejects lighting.' },
    { name: 'animate', title: 'Animate Image', inputSchema: z.object(animateShape),
      description: 'Animate a start frame with a motion prompt and optional end frame. Returns a VIDEO URL; image preview/save utilities do not support videos. Usually takes 60–90 seconds; set the MCP host tool timeout accordingly.' },
    { name: 'upscale', title: 'Upscale to 4K or 8K', inputSchema: upscaleSchema,
      description: 'Upscale to 3840 (4k) or 7680 (8k) pixels on the longer side. Defaults to 4k and jpg. At 8k, only jpg or webp output is available.' },
  ];
  for (const tool of tools) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: `${tool.description} Image inputs accept public HTTPS URLs or image data URIs. Charges the API account; cost and balance are in USD.`,
      inputSchema: tool.inputSchema,
      outputSchema: generationOutputShape,
      annotations: GENERATION_ANNOTATIONS,
    }, async (args) => generate(deps, API_TOOL_ENDPOINTS[tool.name], tool.name, tool.title, args));
  }

  server.registerTool('auto_prompt', {
    title: 'Auto Prompt',
    description: 'Analyze an image and return a descriptive render prompt as plain text, not a URL. Charges the API account; cost and balance are in USD.',
    inputSchema: autoPromptShape,
    outputSchema: autoPromptOutputShape,
    annotations: GENERATION_ANNOTATIONS,
  }, async (args) => {
    try {
      const result = await deps.client.autoPrompt(args);
      await deps.session.record({ tool: 'auto_prompt', ...result, output: [result.output], outputType: 'text' });
      return {
        content: [{ type: 'text', text: `${result.output}\n\nCost: $${formatNumber(result.cost)} USD · Balance: $${formatNumber(result.balance)} USD${requestIdNote(result.requestId)}` }],
        structuredContent: { ...result },
      };
    } catch (err) {
      recordFailure(deps, err);
      return formatError('Auto prompt', err);
    }
  });

  server.registerTool('balance', {
    title: 'Check Account Balance',
    description: 'Fetch the current API account balance in USD without spending USD. Unlike usage_summary, this reads the live balance.',
    inputSchema: {}, outputSchema: balanceOutputShape,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async () => {
    try {
      const result = await deps.client.balance();
      deps.session.updateBalance(result.balance);
      return { content: [{ type: 'text', text: `Account balance: $${formatNumber(result.balance)} USD` }], structuredContent: { ...result } };
    } catch (err) {
      return formatError('Balance check', err);
    }
  });
}

function registerQolTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'preview_image',
    {
      title: 'Preview Image',
      description:
        'Load an image and return it inline so you (the agent) and GUI clients can actually see it — useful for ' +
        'inspecting a generation result before continuing. Accepts a public HTTPS URL, an inline ' +
        'data:image/<mime>;base64,<payload> URI, or a local file path. Optionally also opens it in the default ' +
        'browser when a display is available. Does not charge the API account.',
      inputSchema: previewImageShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, open }) => {
      try {
        const fetched = await deps.media.fetchForPreview(url);
        // A data: URI *is* the image, not a path/URL the OS can open — never hand
        // megabytes of base64 to `open`/`xdg-open`, nor tell the user to open it.
        const kind = classifyImageInput(url);
        const isDataUri = kind === 'data';
        // Resolve ~/relative/file:// inputs to an absolute path before the OS
        // opener — `open`/`xdg-open` don't expand `~`.
        const opened = open === true && !isDataUri
          ? openInBrowser(kind === 'path' ? resolveLocalPath(url) : url)
          : false;
        const note = open === true && isDataUri
          ? ' — inline data URI, nothing to open in a browser.'
          : openNote(open === true, opened);
        if (fetched.tooLarge) {
          const tail = isDataUri
            ? ' The inline data URI is too large to display.'
            : `\nOpen it directly:\n${describeSource(url)}`;
          return text(
            `Image is ${formatBytes(fetched.bytes)} — too large to embed inline ` +
              `(limit ${formatBytes(deps.config.maxPreviewBytes)}).${tail}${note}`,
          );
        }
        return {
          content: [
            { type: 'text', text: `Preview of ${describeSource(url)} (${formatBytes(fetched.bytes)}, ${fetched.mimeType})${note}` },
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
        'Save an image to local disk (defaults to the configured download directory) and return the saved file ' +
        'path. Accepts a public HTTPS URL, an inline data:image/<mime>;base64,<payload> URI, or a local file ' +
        'path. Generation output URLs are public but may expire, so saving keeps a permanent copy. Consumes no ' +
        'API balance.',
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
        'otherwise spend money on a request guaranteed to fail). Does not charge the API account.',
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
        "Report this session's MyArchitectAI usage: number of generations, total USD spent, the last known " +
        'balance (from the most recent generation — no paid call), and a per-tool breakdown. Does not charge the API account.',
      outputSchema: usageOutputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const summary = deps.session.summary();
      const fingerprint = apiKeyFingerprint(deps.config.apiKey);
      const lines = [
        `API key: ${fingerprint}`,
        `Generations this session: ${summary.totalGenerations}`,
        `Failed generations: ${summary.failedGenerations}`,
        `Total cost: ${formatNumber(summary.totalCost)} USD`,
        `Last known balance: ${summary.lastKnownBalance === null ? 'unknown (no generations yet)' : `${formatNumber(summary.lastKnownBalance)} USD`}`,
      ];
      for (const [tool, value] of Object.entries(summary.byTool)) {
        lines.push(`  - ${tool}: ${value.count}× (${formatNumber(value.cost)} USD)`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          totalGenerations: summary.totalGenerations,
          failedGenerations: summary.failedGenerations,
          totalCost: summary.totalCost,
          lastKnownBalance: summary.lastKnownBalance,
          byTool: summary.byTool,
          since: summary.since,
          apiKeyFingerprint: fingerprint,
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
        'or reuse an earlier result without regenerating it — and without spending USD.',
      inputSchema: listRecentShape,
      outputSchema: listRecentOutputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      const generations = deps.session.recent(limit ?? 10);
      const lines = generations.length
        ? generations.map(
            (record) =>
              `#${record.id} ${record.tool} @ ${record.createdAt} — ${record.output.length} ${record.outputType ?? 'image'} result(s), ` +
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
      ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
      outputType: toolName === 'animate' ? 'video' : 'image',
    });
    return formatSuccess(label, result, toolName === 'animate' ? 'video' : 'image');
  } catch (err) {
    // Count API/validation rejections (not transport errors) and capture any
    // balance the API reported on the failed call.
    recordFailure(deps, err);
    return formatError(label, err);
  }
}

function recordFailure(deps: ToolDeps, err: unknown): void {
  if (err instanceof MyArchitectAIError && err.kind !== 'network' && err.kind !== 'timeout') {
    deps.session.recordFailure(err.balance);
  }
}

function requestIdNote(requestId: number | undefined): string {
  return requestId === undefined ? '' : ` · Request ID: ${requestId}`;
}

function formatSuccess(label: string, result: GenerationResult, outputType: 'image' | 'video'): CallToolResult {
  const { output, balance, cost } = result;
  const count = output.length;
  const lines = [
    `${label} complete — ${count} ${outputType}${count === 1 ? '' : 's'} generated.`,
    '',
    ...output.map((url, index) => `${index + 1}. ${url}`),
    '',
    `Cost: $${formatNumber(cost)} USD · Remaining balance: $${formatNumber(balance)} USD${requestIdNote(result.requestId)}`,
  ];
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: { ...result },
  };
}

function formatError(label: string, err: unknown): CallToolResult {
  if (err instanceof MyArchitectAIError) {
    const meta: string[] = [];
    if (err.requestId !== undefined) meta.push(`request ID ${err.requestId}`);
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

/** Render a USD amount without floating-point noise or trailing zeros. */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  return (Math.round(value * 1e4) / 1e4).toString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
