FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN addgroup -S mcp && adduser -S -G mcp -h /home/mcp mcp
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
RUN mkdir -p /app/data && chown -R mcp:mcp /app/data
USER mcp
ENV NODE_ENV=production MCP_TRANSPORT=http MCP_HTTP_HOST=0.0.0.0 MCP_HTTP_PORT=3020 \
    API_KEYS_FILE=/app/data/api-keys.json AUDIT_LOG_FILE=/app/data/audit.log
EXPOSE 3020
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3020/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
