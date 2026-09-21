/** Local diagnostics only. Never put keys, prompts, image inputs or upstream bodies in logs. */
export const logEvent = (fields: Record<string, string | number | undefined>): void => {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), service: 'myarchitectai-mcp', ...fields })}\n`);
};
