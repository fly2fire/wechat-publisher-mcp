#!/bin/bash
# 启动 wechat-publisher-mcp HTTP 服务器

export PORT=${PORT:-3003}
export MCP_TRANSPORT=http

cd "$(dirname "$0")"
node src/server.js
