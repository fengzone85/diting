# ===== 阶段一：构建 Vue3 前端 =====
# 前端源码在 web/，Vite 构建产物输出到 ../public（见 web/vite.config.ts 的 build.outDir）。
# 因根 .gitignore 把 server/public/index.html 与 server/public/assets/ 视为「部署端重建的产物」而排除出 git，
# 必须在此阶段真正执行 npm run build 产出默认 dashboard，否则容器缺 index.html 访问 / 会 404。
FROM node:22.21.1-slim AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ===== 阶段二：运行时（Node 服务端）=====
FROM node:22.21.1-slim
WORKDIR /app
COPY package*.json ./
# npm ci 严格按 package-lock.json 复现依赖树（npm install 可能漂移到更新的次版本）。
# better-sqlite3 为原生模块：优先从 GitHub 下载预编译二进制；若构建机访问 GitHub 受限，
# 则回退 node-gyp 本地编译，需要 python3/make/g++。工具在本层内装/删，不残留在镜像。
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY . .
COPY --from=web-builder /app/public/index.html ./public/index.html
COPY --from=web-builder /app/public/assets ./public/assets
RUN mkdir -p /data /app/data && chown -R node:node /app /data
USER node
EXPOSE 8081
CMD ["node", "server.js"]
