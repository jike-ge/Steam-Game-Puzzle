# 零依赖：没有 npm install，镜像就是一层代码
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    TZ=Asia/Shanghai

COPY package.json ./
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY data/demo-library.json ./data/demo-library.json

# 缓存目录 + 时区数据（alpine 默认没有 tzdata，TZ 会失效）
RUN apk add --no-cache tzdata \
    && mkdir -p /app/data/cache /app/data/covers

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
