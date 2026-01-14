import { randomUUID } from 'node:crypto';
import { promises as fs } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

/**
 * 客户端存储 - 管理注册的 OAuth 客户端
 */
export class ClientsStore {
  constructor(storagePath) {
    this.storagePath = storagePath;
    this.clients = new Map();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    try {
      const data = await fs.readFile(this.storagePath, 'utf8');
      const parsed = JSON.parse(data);
      if (parsed.clients) {
        for (const [id, client] of Object.entries(parsed.clients)) {
          this.clients.set(id, client);
        }
      }
      logger.info('OAuth clients loaded', { count: this.clients.size });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to load OAuth clients', { error: error.message });
      }
    }
    this.loaded = true;
  }

  async save() {
    const data = {
      clients: Object.fromEntries(this.clients)
    };
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    await fs.writeFile(this.storagePath, JSON.stringify(data, null, 2));
  }

  async getClient(clientId) {
    await this.load();
    return this.clients.get(clientId);
  }

  async registerClient(clientMetadata) {
    await this.load();
    this.clients.set(clientMetadata.client_id, clientMetadata);
    await this.save();
    logger.info('OAuth client registered', { clientId: clientMetadata.client_id });
    return clientMetadata;
  }
}

/**
 * OAuth Provider - 实现 MCP OAuth 认证流程
 * 支持文件持久化存储
 */
export class OAuthProvider {
  constructor(options = {}) {
    const storagePath = options.storagePath || './data/oauth-store.json';
    this.clientsStore = new ClientsStore(storagePath);
    this.validateResource = options.validateResource;

    // 内存中的临时存储（授权码和令牌）
    this.codes = new Map();
    this.tokens = new Map();

    // 从文件加载持久化的令牌
    this.tokensStoragePath = options.tokensStoragePath || './data/oauth-tokens.json';
    this.tokensLoaded = false;
  }

  async loadTokens() {
    if (this.tokensLoaded) return;
    try {
      const data = await fs.readFile(this.tokensStoragePath, 'utf8');
      const parsed = JSON.parse(data);
      if (parsed.tokens) {
        for (const [token, tokenData] of Object.entries(parsed.tokens)) {
          // 只加载未过期的令牌
          if (tokenData.expiresAt > Date.now()) {
            this.tokens.set(token, tokenData);
          }
        }
      }
      logger.info('OAuth tokens loaded', { count: this.tokens.size });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to load OAuth tokens', { error: error.message });
      }
    }
    this.tokensLoaded = true;
  }

  async saveTokens() {
    const data = {
      tokens: Object.fromEntries(this.tokens)
    };
    await fs.mkdir(path.dirname(this.tokensStoragePath), { recursive: true });
    await fs.writeFile(this.tokensStoragePath, JSON.stringify(data, null, 2));
  }

  /**
   * 处理授权请求 - 生成授权码并重定向
   */
  async authorize(client, params, res) {
    const code = randomUUID();
    const searchParams = new URLSearchParams({ code });

    if (params.state !== undefined) {
      searchParams.set('state', params.state);
    }

    this.codes.set(code, {
      client,
      params,
      createdAt: Date.now()
    });

    // 授权码 10 分钟后过期
    setTimeout(() => {
      this.codes.delete(code);
    }, 10 * 60 * 1000);

    const targetUrl = new URL(client.redirect_uris[0]);
    targetUrl.search = searchParams.toString();

    logger.info('OAuth authorization code generated', {
      clientId: client.client_id,
      redirectUri: targetUrl.toString().split('?')[0]
    });

    res.redirect(targetUrl.toString());
  }

  /**
   * 获取授权码的 code challenge
   */
  async challengeForAuthorizationCode(client, authorizationCode) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) {
      throw new Error('Invalid authorization code');
    }
    return codeData.params.codeChallenge;
  }

  /**
   * 交换授权码获取访问令牌
   */
  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier) {
    const codeData = this.codes.get(authorizationCode);

    if (!codeData) {
      throw new Error('Invalid authorization code');
    }

    if (codeData.client.client_id !== client.client_id) {
      throw new Error(`Authorization code was not issued to this client`);
    }

    if (this.validateResource && !this.validateResource(codeData.params.resource)) {
      throw new Error(`Invalid resource: ${codeData.params.resource}`);
    }

    this.codes.delete(authorizationCode);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const expiresIn = 3600; // 1 hour

    const tokenData = {
      token: accessToken,
      clientId: client.client_id,
      scopes: codeData.params.scopes || [],
      expiresAt: Date.now() + expiresIn * 1000,
      resource: codeData.params.resource,
      type: 'access',
      refreshToken
    };

    this.tokens.set(accessToken, tokenData);

    // 存储 refresh token
    this.tokens.set(refreshToken, {
      token: refreshToken,
      clientId: client.client_id,
      scopes: codeData.params.scopes || [],
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000, // 30 days
      resource: codeData.params.resource,
      type: 'refresh',
      accessToken
    });

    await this.saveTokens();

    logger.info('OAuth access token issued', {
      clientId: client.client_id,
      expiresIn
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: (codeData.params.scopes || []).join(' ')
    };
  }

  /**
   * 刷新访问令牌
   */
  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    await this.loadTokens();

    const tokenData = this.tokens.get(refreshToken);

    if (!tokenData || tokenData.type !== 'refresh') {
      throw new Error('Invalid refresh token');
    }

    if (tokenData.clientId !== client.client_id) {
      throw new Error('Refresh token was not issued to this client');
    }

    if (tokenData.expiresAt < Date.now()) {
      this.tokens.delete(refreshToken);
      throw new Error('Refresh token expired');
    }

    // 删除旧的 access token
    if (tokenData.accessToken) {
      this.tokens.delete(tokenData.accessToken);
    }

    const newAccessToken = randomUUID();
    const expiresIn = 3600;

    const newTokenData = {
      token: newAccessToken,
      clientId: client.client_id,
      scopes: scopes || tokenData.scopes,
      expiresAt: Date.now() + expiresIn * 1000,
      resource: resource || tokenData.resource,
      type: 'access',
      refreshToken
    };

    this.tokens.set(newAccessToken, newTokenData);

    // 更新 refresh token 关联的 access token
    tokenData.accessToken = newAccessToken;

    await this.saveTokens();

    logger.info('OAuth access token refreshed', {
      clientId: client.client_id
    });

    return {
      access_token: newAccessToken,
      token_type: 'bearer',
      expires_in: expiresIn,
      scope: (scopes || tokenData.scopes).join(' ')
    };
  }

  /**
   * 验证访问令牌
   */
  async verifyAccessToken(token) {
    await this.loadTokens();

    const tokenData = this.tokens.get(token);

    if (!tokenData) {
      throw new Error('Invalid token');
    }

    if (tokenData.type !== 'access') {
      throw new Error('Not an access token');
    }

    if (tokenData.expiresAt < Date.now()) {
      this.tokens.delete(token);
      await this.saveTokens();
      throw new Error('Token expired');
    }

    return {
      token,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000),
      resource: tokenData.resource
    };
  }

  /**
   * 撤销令牌
   */
  async revokeToken(token) {
    await this.loadTokens();

    const tokenData = this.tokens.get(token);
    if (tokenData) {
      // 如果是 access token，同时删除关联的 refresh token
      if (tokenData.type === 'access' && tokenData.refreshToken) {
        this.tokens.delete(tokenData.refreshToken);
      }
      // 如果是 refresh token，同时删除关联的 access token
      if (tokenData.type === 'refresh' && tokenData.accessToken) {
        this.tokens.delete(tokenData.accessToken);
      }
      this.tokens.delete(token);
      await this.saveTokens();
      logger.info('OAuth token revoked');
    }
  }
}

export default OAuthProvider;
