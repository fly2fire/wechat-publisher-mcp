# OAuth 认证配置指南

本文档介绍如何为 WeChat Publisher MCP 服务器配置 OAuth 2.0 认证。

## 快速开始

### 本地开发（不启用 OAuth）

```bash
docker compose up -d
```

### 生产环境（启用 OAuth）

```bash
# 设置环境变量
export MCP_BASE_URL=https://your-domain.com

# 启动 OAuth 版本
docker compose -f docker-compose.oauth.yml up -d
```

## 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `MCP_OAUTH` | `false` | 是否启用 OAuth 认证 |
| `MCP_BASE_URL` | `http://localhost:3003` | 服务器公网 URL（生产环境必须正确配置） |
| `MCP_OAUTH_STRICT` | `false` | 是否启用严格资源验证 |
| `MCP_DATA_PATH` | `./data` | OAuth 数据存储路径 |

## OAuth 端点

启用 OAuth 后，服务器提供以下端点：

| 端点 | 说明 |
|------|------|
| `/.well-known/oauth-authorization-server` | OAuth 发现文档 |
| `/register` | 动态客户端注册 |
| `/authorize` | 授权端点 |
| `/token` | 令牌端点 |
| `/oauth/introspect` | 令牌内省端点 |
| `/oauth/revoke` | 令牌撤销端点 |

## 客户端配置

### 1. 注册客户端

首先需要注册一个 OAuth 客户端：

```bash
curl -X POST http://localhost:3003/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "My MCP Client",
    "redirect_uris": ["http://localhost:8080/callback"],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "scope": "mcp:tools mcp:read mcp:write"
  }'
```

响应示例：

```json
{
  "client_id": "abc123...",
  "client_secret": "xyz789...",
  "client_name": "My MCP Client",
  "redirect_uris": ["http://localhost:8080/callback"],
  "grant_types": ["authorization_code", "refresh_token"]
}
```

### 2. 配置 MCP 客户端

在 `.mcp.json` 中配置带认证的 MCP 服务器：

```json
{
  "mcpServers": {
    "wechat-publisher": {
      "type": "http",
      "url": "https://your-domain.com/mcp",
      "oauth": {
        "client_id": "your-client-id",
        "client_secret": "your-client-secret",
        "authorization_url": "https://your-domain.com/authorize",
        "token_url": "https://your-domain.com/token",
        "scope": "mcp:tools"
      }
    }
  }
}
```

## 认证流程

### OAuth 2.0 授权码流程

1. **客户端注册** - 获取 `client_id` 和 `client_secret`
2. **授权请求** - 用户被重定向到 `/authorize` 进行授权
3. **授权码交换** - 客户端用授权码换取访问令牌
4. **API 访问** - 使用 Bearer Token 访问 MCP 端点

### 令牌刷新

访问令牌有效期为 1 小时，可使用 refresh_token 刷新：

```bash
curl -X POST http://localhost:3003/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token&refresh_token=YOUR_REFRESH_TOKEN&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET"
```

## 安全最佳实践

### 生产环境部署

1. **使用 HTTPS** - 必须通过 HTTPS 暴露服务
2. **设置正确的 BASE_URL** - `MCP_BASE_URL` 必须匹配实际访问 URL
3. **启用严格模式** - 设置 `MCP_OAUTH_STRICT=true`
4. **保护数据卷** - OAuth 数据卷包含敏感令牌信息

### Nginx 反向代理示例

```nginx
server {
    listen 443 ssl;
    server_name mcp.your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3003;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## 故障排除

### 常见错误

**401 Unauthorized**
- 检查 Bearer Token 是否正确
- 确认令牌未过期
- 验证客户端凭据

**Invalid client**
- 确认 client_id 和 client_secret 正确
- 检查客户端是否已注册

**Invalid redirect_uri**
- redirect_uri 必须与注册时完全匹配

### 调试模式

启用调试日志查看详细信息：

```bash
docker compose -f docker-compose.oauth.yml up -d
docker logs -f wechat-publisher-mcp
```

## 数据持久化

OAuth 数据存储在 Docker 卷中：

- `wechat-publisher-data:/app/data`
  - `oauth-clients.json` - 注册的客户端
  - `oauth-tokens.json` - 访问令牌和刷新令牌

备份数据：

```bash
docker run --rm -v wechat-publisher-mcp_wechat-publisher-data:/data -v $(pwd):/backup alpine tar cvf /backup/oauth-backup.tar /data
```

恢复数据：

```bash
docker run --rm -v wechat-publisher-mcp_wechat-publisher-data:/data -v $(pwd):/backup alpine tar xvf /backup/oauth-backup.tar -C /
```
