# Container image for the MyArchitectAI MCP server.
#
# The server speaks MCP over stdio, so run the container with stdin attached
# and provide the API key at runtime:
#   docker run -i -e MYARCHITECTAI_API_KEY=sk-... myarchitectai-mcp
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# stdio transport: keep STDIN open; no port is exposed.
ENTRYPOINT ["node", "dist/index.js"]
