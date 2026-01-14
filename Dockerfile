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

ENV PORT=3003
ENV MCP_TRANSPORT=http

EXPOSE 3003

CMD ["node", "src/server.js"]
