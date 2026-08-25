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
RUN npm install --omit=dev
COPY . .
COPY --from=web-builder /app/public/index.html ./public/index.html
COPY --from=web-builder /app/public/assets ./public/assets
RUN mkdir -p /data /app/data && chown -R node:node /app /data
USER node
EXPOSE 8081
CMD ["node", "server.js"]
