export const hostedEnv = (): NodeJS.ProcessEnv => ({
  MCP_BILLING_MODE: 'api-balance',
  MCP_DEPLOYMENT_REVISION: '0123456789abcdef0123456789abcdef01234567',
  PORTAL_SUPABASE_URL: 'https://portal-project.supabase.co',
  PORTAL_BASE_URL: 'https://portal.example',
  MCP_PORTAL_SIGNING_SECRET: 'synthetic-portal-signing-secret-at-least-32-characters',
  MCP_ALLOWED_HOSTS: '["127.0.0.1"]',
});
