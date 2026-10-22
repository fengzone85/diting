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
# 编译期可选的 APT 镜像源（国内网络下 apt 拉 g++ 常慢到十几分钟）：
#   docker compose build --build-arg APT_MIRROR=mirrors.aliyun.com
# 或在 .env 写 APT_MIRROR=…（compose 的 build.args 会读它）。
ARG APT_MIRROR=""
# npm ci 严格按 package-lock.json 复现依赖树（npm install 可能漂移到更新的次版本）。
# better-sqlite3 是原生模块：能拿到预编译二进制时 npm ci 直接成功，**完全不需要**编译工具链；
# 只有取不到（GitHub 不可达）才回退 node-gyp，此时才装 python3/make/g++，用完再卸。
# 旧实现无条件 apt install —— 即使预编译可用也要多下 ~300MB，首次部署被拖到十几分钟。
RUN npm ci --omit=dev || ( \
        set -eux; \
        if [ -n "$APT_MIRROR" ]; then \
            sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
            sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list; \
        fi; \
        apt-get update; \
        apt-get install -y --no-install-recommends python3 make g++; \
        npm ci --omit=dev; \
        apt-get purge -y --auto-remove python3 make g++; \
        rm -rf /var/lib/apt/lists/* \
    )
COPY . .
COPY --from=web-builder /app/public/index.html ./public/index.html
COPY --from=web-builder /app/public/assets ./public/assets
RUN mkdir -p /data /app/data && chown -R node:node /app /data
USER node
EXPOSE 8081
CMD ["node", "server.js"]
