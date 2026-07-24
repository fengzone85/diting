FROM node:22.21.1-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8081
CMD ["node", "server.js"]
