FROM node:22.21.1-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# 以非 root 运行：预建 /data 与回退数据目录并改属主。
# 命名卷首次挂载会继承镜像内挂载点的属主，故 node 用户可直接写 /data。
RUN mkdir -p /data /app/data && chown -R node:node /app /data
USER node
EXPOSE 8081
CMD ["node", "server.js"]
