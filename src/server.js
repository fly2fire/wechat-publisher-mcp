#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { z } from 'zod';
import WeChatPublisher from './tools/wechat-publisher.js';
import WeChatStatus from './tools/wechat-status.js';
import { setupOAuth } from './auth/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 检查是否启用 OAuth
const useOAuth = process.env.MCP_OAUTH === 'true' || process.env.MCP_OAUTH === '1';

// 日志输出到 stderr，避免干扰 stdio 协议
const logger = {
  info: (msg, data) => console.error(`[INFO] ${msg}`, data || ''),
  error: (msg, error) => console.error(`[ERROR] ${msg}`, error || ''),
  debug: (msg, data) => process.env.DEBUG && console.error(`[DEBUG] ${msg}`, data || '')
};

// 创建 MCP 服务器
function createMcpServer() {
  const server = new McpServer({
    name: "wechat-publisher-mcp",
    version: "1.0.0"
  });

  // 注册微信发布工具
  server.registerTool(
    "wechat_publish_article",
    {
      description: "将文章发布到微信公众号，支持Markdown格式",
      inputSchema: {
        title: z.string().describe("文章标题"),
        content: z.string().describe("文章内容，支持Markdown或HTML格式"),
        author: z.string().describe("作者名称"),
        appId: z.string().describe("微信公众号AppID"),
        appSecret: z.string().describe("微信公众号AppSecret"),
        coverImagePath: z.string().optional().describe("封面图片路径"),
        contentType: z.enum(['markdown', 'html']).default('markdown').describe("内容格式：markdown 或 html"),
        previewMode: z.boolean().default(false).describe("是否为预览模式"),
        previewOpenId: z.string().optional().describe("预览用户OpenID"),
        draftOnly: z.boolean().default(true).describe("是否仅创建草稿不发布，默认true")
      }
    },
    async (params) => {
      const { title, content, author, appId, appSecret, coverImagePath, contentType = 'markdown', previewMode, previewOpenId, draftOnly = true } = params;
      logger.info(`Publishing article: ${title}`);

      try {
        const result = await WeChatPublisher.publish({
          title,
          content,
          author,
          appId,
          appSecret,
          coverImagePath,
          contentType,
          previewMode,
          previewOpenId,
          draftOnly
        });

        return result;
      } catch (error) {
        logger.error(`发布失败: ${error.message}`);
        return {
          content: [{
            type: "text",
            text: `❌ 发布失败: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // 注册状态查询工具
  server.registerTool(
    "wechat_query_status",
    {
      description: "查询文章发布状态和统计数据",
      inputSchema: {
        msgId: z.string().describe("消息ID"),
        appId: z.string().describe("微信公众号AppID"),
        appSecret: z.string().describe("微信公众号AppSecret")
      }
    },
    async (params) => {
      const { msgId, appId, appSecret } = params;
      logger.info(`Querying status for message: ${msgId}`);

      try {
        const result = await WeChatStatus.query({
          msgId,
          appId,
          appSecret
        });

        return result;
      } catch (error) {
        logger.error(`查询失败: ${error.message}`);
        return {
          content: [{
            type: "text",
            text: `❌ 查询失败: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  return server;
}

// HTTP 模式启动 (使用 StreamableHTTPServerTransport)
async function startHttpServer(port) {
  const app = express();

  // 存储活跃的 sessions
  const transports = {};

  // OAuth 配置
  let authMiddleware = null;
  const baseUrl = process.env.MCP_BASE_URL || `http://localhost:${port}`;
  const mcpServerUrl = new URL(`${baseUrl}/mcp`);

  if (useOAuth) {
    logger.info('OAuth authentication enabled');

    const oauth = setupOAuth({
      mcpServerUrl,
      storagePath: process.env.MCP_DATA_PATH || './data',
      strictResource: process.env.MCP_OAUTH_STRICT === 'true'
    });

    // 设置 OAuth 路由
    oauth.setupRoutes(app);
    authMiddleware = oauth.authMiddleware;

    logger.info('OAuth endpoints configured', {
      authorize: `${baseUrl}/authorize`,
      token: `${baseUrl}/token`,
      introspect: `${baseUrl}/oauth/introspect`
    });
  } else {
    app.use(express.json());
  }

  // 健康检查
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      server: 'wechat-publisher-mcp',
      sessions: Object.keys(transports).length,
      oauth: useOAuth
    });
  });

  // MCP POST 处理函数
  const mcpPostHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (useOAuth && req.auth) {
      logger.debug('Authenticated request', { clientId: req.auth.clientId });
    }

    if (sessionId && transports[sessionId]) {
      // 复用已有 session
      transport = transports[sessionId];
      logger.debug(`Reusing session: ${sessionId}`);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // 新 session 初始化
      logger.info('New session initialization request');

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
          logger.info(`Session initialized: ${id}`);
        },
        onsessionclosed: (id) => {
          delete transports[id];
          logger.info(`Session closed: ${id}`);
        }
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          logger.info(`Transport closed for session: ${transport.sessionId}`);
        }
      };

      // 创建并连接 MCP 服务器
      const server = createMcpServer();
      await server.connect(transport);
    } else {
      logger.error('Invalid session request', { sessionId, body: req.body });
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid session' },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  };

  // MCP GET 处理函数 (SSE streaming)
  const mcpGetHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const transport = transports[sessionId];

    if (transport) {
      await transport.handleRequest(req, res);
    } else {
      res.status(400).json({ error: 'Invalid session' });
    }
  };

  // MCP DELETE 处理函数 (关闭 session)
  const mcpDeleteHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const transport = transports[sessionId];

    if (transport) {
      await transport.handleRequest(req, res);
    } else {
      res.status(400).json({ error: 'Invalid session' });
    }
  };

  // 根据是否启用 OAuth 设置路由
  if (useOAuth && authMiddleware) {
    app.post('/mcp', authMiddleware, mcpPostHandler);
    app.get('/mcp', authMiddleware, mcpGetHandler);
    app.delete('/mcp', authMiddleware, mcpDeleteHandler);
  } else {
    app.post('/mcp', mcpPostHandler);
    app.get('/mcp', mcpGetHandler);
    app.delete('/mcp', mcpDeleteHandler);
  }

  app.listen(port, () => {
    logger.info(`HTTP server listening on port ${port}`);
    logger.info(`MCP endpoint: ${mcpServerUrl.toString()}`);
    logger.info(`Health check: ${baseUrl}/health`);
    if (useOAuth) {
      logger.info('OAuth authentication: ENABLED');
      logger.info(`OAuth discovery: ${baseUrl}/.well-known/oauth-authorization-server`);
    } else {
      logger.info('OAuth authentication: DISABLED (set MCP_OAUTH=true to enable)');
    }
  });
}

// Stdio 模式启动
async function startStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Connected via stdio');
  return server;
}

// 主启动逻辑
async function main() {
  const transportMode = process.env.MCP_TRANSPORT || 'stdio';
  const port = parseInt(process.env.PORT || '3003', 10);

  logger.info('WeChat Publisher MCP Server initializing...');

  if (transportMode === 'http' || transportMode === 'sse') {
    await startHttpServer(port);
  } else {
    await startStdioServer();
  }
}

// Start server if running directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    logger.error('Failed to start server', error);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down...');
    process.exit(0);
  });
}

export default { createMcpServer, startHttpServer, startStdioServer };
