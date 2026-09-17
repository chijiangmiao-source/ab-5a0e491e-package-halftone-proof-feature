# syntax=docker/dockerfile:1

# ---------- 依赖层（debian slim，npm ci 得到可跨 glibc 发行版复用的 node_modules） ----------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# 该层无需浏览器；verify 层使用 Playwright 官方镜像内预装的 Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- 构建层：类型检查 + 生产构建 ----------
FROM deps AS build
COPY . .
RUN npm run build

# ---------- 验收层：Playwright 官方镜像自带匹配版本的 Chromium 与全部系统库 ----------
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS verify
WORKDIR /app
# 官方镜像内 root 启动 Chromium 时 Playwright 自动附加 --no-sandbox
USER root
ENV CI=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 一次性验收：Vitest 单测 → 类型检查/构建 → Playwright 端到端（容器内自起预览服务）
CMD ["npm", "run", "verify"]

# ---------- 运行层：仅静态文件与零依赖 Node 服务器，不带构建工具链 ----------
FROM node:20-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY package.json ./
EXPOSE 8080
CMD ["node", "scripts/serve.mjs"]
