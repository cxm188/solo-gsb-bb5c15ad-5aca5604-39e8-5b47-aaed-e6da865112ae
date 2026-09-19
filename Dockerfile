# ---------- 前端构建 ----------
FROM node:20-alpine AS client-build
WORKDIR /build/client
COPY client/package*.json ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---------- 后端构建 ----------
FROM node:20-alpine AS server-build
WORKDIR /build/server
COPY server/package*.json ./
RUN npm install --no-audit --no-fund
COPY server/ ./
RUN npm run build

# ---------- 运行时 ----------
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=server-build /build/server/dist ./server/dist
COPY --from=client-build /build/client/dist ./client/dist
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
