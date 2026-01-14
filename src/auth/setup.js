import express from 'express';
import { createOAuthMetadata, mcpAuthRouter, mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { OAuthProvider } from './OAuthProvider.js';
import logger from '../utils/logger.js';

/**
 * 设置 OAuth 认证服务
 *
 * @param {Object} options 配置选项
 * @param {URL} options.mcpServerUrl MCP 服务器 URL
 * @param {URL} options.authServerUrl OAuth 认证服务器 URL（可选，默认与 MCP 同一服务器）
 * @param {boolean} options.strictResource 是否严格验证资源
 * @param {string} options.storagePath 数据存储路径
 * @returns {Object} { provider, authMiddleware, setupRoutes }
 */
export function setupOAuth(options = {}) {
  const {
    mcpServerUrl,
    authServerUrl,
    strictResource = false,
    storagePath = './data'
  } = options;

  // 验证资源函数
  const validateResource = strictResource ? (resource) => {
    if (!resource) return false;
    // 检查资源是否匹配 MCP 服务器 URL
    const mcpUrl = new URL(mcpServerUrl);
    const resourceUrl = new URL(resource);
    return resourceUrl.origin === mcpUrl.origin;
  } : undefined;

  // 创建 OAuth Provider
  const provider = new OAuthProvider({
    storagePath: `${storagePath}/oauth-clients.json`,
    tokensStoragePath: `${storagePath}/oauth-tokens.json`,
    validateResource
  });

  // 使用 authServerUrl 或 mcpServerUrl 作为 issuer
  const issuerUrl = authServerUrl || mcpServerUrl;

  // 创建 OAuth 元数据
  const oauthMetadata = createOAuthMetadata({
    provider,
    issuerUrl,
    scopesSupported: ['mcp:tools', 'mcp:read', 'mcp:write']
  });

  // 添加 introspection endpoint
  oauthMetadata.introspection_endpoint = new URL('/oauth/introspect', issuerUrl).href;

  // Token verifier for Bearer auth middleware
  const tokenVerifier = {
    verifyAccessToken: async (token) => {
      return await provider.verifyAccessToken(token);
    }
  };

  // 创建认证中间件
  const authMiddleware = requireBearerAuth({
    verifier: tokenVerifier,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl)
  });

  /**
   * 设置 OAuth 路由到 Express app
   */
  function setupRoutes(app) {
    // 解析 JSON 和 URL encoded body
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // OAuth 认证路由（授权、令牌等）
    app.use(mcpAuthRouter({
      provider,
      issuerUrl,
      scopesSupported: ['mcp:tools', 'mcp:read', 'mcp:write']
    }));

    // MCP 认证元数据路由
    app.use(mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: mcpServerUrl,
      scopesSupported: ['mcp:tools', 'mcp:read', 'mcp:write'],
      resourceName: 'WeChat Publisher MCP Server'
    }));

    // Token introspection endpoint
    app.post('/oauth/introspect', async (req, res) => {
      try {
        const { token } = req.body;
        if (!token) {
          res.status(400).json({ error: 'Token is required' });
          return;
        }

        const tokenInfo = await provider.verifyAccessToken(token);
        res.json({
          active: true,
          client_id: tokenInfo.clientId,
          scope: tokenInfo.scopes.join(' '),
          exp: tokenInfo.expiresAt,
          aud: tokenInfo.resource
        });
      } catch (error) {
        res.json({
          active: false
        });
      }
    });

    // Token revocation endpoint
    app.post('/oauth/revoke', async (req, res) => {
      try {
        const { token } = req.body;
        if (token) {
          await provider.revokeToken(token);
        }
        res.status(200).end();
      } catch (error) {
        logger.error('Token revocation failed', { error: error.message });
        res.status(200).end(); // RFC 7009 规定即使失败也返回 200
      }
    });

    logger.info('OAuth routes configured', {
      issuer: issuerUrl.toString(),
      introspectionEndpoint: oauthMetadata.introspection_endpoint
    });
  }

  return {
    provider,
    authMiddleware,
    oauthMetadata,
    setupRoutes
  };
}

export default setupOAuth;
