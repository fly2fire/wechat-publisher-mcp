FROM node:20-slim

# canvas 原生依赖
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

# 创建数据目录用于 OAuth 持久化存储
RUN mkdir -p /app/data

# 环境变量
ENV PORT=3003
ENV MCP_TRANSPORT=http
ENV MCP_DATA_PATH=/app/data

# OAuth 配置（默认关闭，生产环境启用）
ENV MCP_OAUTH=false
# ENV MCP_BASE_URL=https://your-domain.com
# ENV MCP_OAUTH_STRICT=true

EXPOSE 3003

# 数据持久化卷
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
