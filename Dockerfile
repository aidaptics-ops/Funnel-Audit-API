# Chromium and every OS library it needs are baked into this base image, and the
# tag is pinned to the exact playwright version in package-lock.json (1.62.1).
# A mismatch between the driver in node_modules and the browsers in /ms-playwright
# makes Playwright refuse to launch, so bump both together or not at all.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS build

WORKDIR /app

# The base image already ships the browsers under /ms-playwright; keep npm from
# re-downloading them into this layer.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Copy the manifests alone first so the dependency layer is reused whenever only
# source files changed. package-lock.json is committed, so npm ci is safe here.
COPY package.json package-lock.json ./
RUN npm ci

# tsc needs the config and the sources; tsconfig has rootDir "src", outDir "dist".
COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Production dependencies only (playwright); tsx/typescript stay in the build stage.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# pwuser is provided by the base image; the browsers are world-readable.
USER pwuser

EXPOSE 3000

# node instead of curl — the base image has no curl, and /health answers without
# touching the browser so it stays green during an analysis.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const h=require('node:http');const r=h.get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/health',timeout:4000},s=>process.exit(s.statusCode===200?0:1));r.on('timeout',()=>{r.destroy();process.exit(1)});r.on('error',()=>process.exit(1))"]

CMD ["node", "dist/server.js"]
