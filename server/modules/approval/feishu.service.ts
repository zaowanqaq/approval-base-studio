import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OAuthToken } from './feishu.types';

export interface ApprovalRuntimeConfig {
  appId: string;
  appSecret: string;
  sessionSecret: string;
  oauthRedirectUri?: string;
  clientBasePath?: string;
  oauthScopes: string;
}

function normalizeEnvValue(value: string | undefined): string {
  return (value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\r\\n|\\r|\\n/g, '')
    .trim();
}

@Injectable()
export class ApprovalConfig implements ApprovalRuntimeConfig {
  readonly appId = normalizeEnvValue(process.env.FEISHU_APP_ID);
  readonly appSecret = normalizeEnvValue(process.env.FEISHU_APP_SECRET);
  readonly sessionSecret = normalizeEnvValue(process.env.APPROVAL_SESSION_SECRET);
  readonly oauthRedirectUri = normalizeEnvValue(process.env.FEISHU_OAUTH_REDIRECT_URI);
  readonly clientBasePath = normalizeEnvValue(process.env.CLIENT_BASE_PATH).replace(/\/$/, '');
  readonly oauthScopes = [
    'auth:user.id:read',
    'offline_access',
    'approval:approval:read',
    'approval:instance:read',
    'approval:instance:write',
    'bitable:app',
    'base:record:read',
    'base:record:update',
    'base:table:read',
    'docs:document.media:download',
  ].join(' ');

  constructor() {
    for (const [name, value] of Object.entries({
      FEISHU_APP_ID: this.appId,
      FEISHU_APP_SECRET: this.appSecret,
      APPROVAL_SESSION_SECRET: this.sessionSecret,
    })) {
      if (!value) throw new Error(`缺少环境变量 ${name}`);
    }
  }
}

type FeishuEnvelope<T> = { code?: number; msg?: string; data?: T } & T;
type RequestOriginSource = Pick<Request, 'headers' | 'protocol' | 'get'>;

@Injectable()
export class FeishuService {
  private readonly tokenCookie = 'approval_feishu_token';
  private readonly key: Buffer;
  private readonly userTokens = new Map<string, OAuthToken>();
  private tenantToken?: { value: string; expiresAt: number };

  constructor(private readonly config: ApprovalConfig) {
    this.key = createHash('sha256').update(config.sessionSecret).digest();
  }

  private cookies(req: Request): Record<string, string> {
    return Object.fromEntries((req.headers.cookie || '').split(';').map((item) => {
      const index = item.indexOf('=');
      return index < 0 ? ['', ''] : [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1))];
    }).filter(([key]) => key));
  }

  private seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
  }

  private unseal<T>(value?: string): T | null {
    if (!value) return null;
    try {
      const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')) as T;
    } catch {
      return null;
    }
  }



  private cookieOptions(maxAge: number) {
    return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', maxAge };
  }

  private userKey(req: Request): string | null {
    const context = req.userContext as { userId?: string } | undefined;
    return context?.userId ? String(context.userId) : null;
  }

  private requestOrigin(req: RequestOriginSource): string {
    const protocol = req.headers['x-forwarded-proto']?.toString().split(',')[0] || req.protocol;
    const host = req.headers['x-forwarded-host']?.toString().split(',')[0] || req.get('host');
    return protocol + '://' + host;
  }

  private redirectUri(req: RequestOriginSource): string {
    const configured = this.config.oauthRedirectUri;
    if (configured) {
      return configured.endsWith('/api/oauth/callback')
        ? configured.slice(0, -'/api/oauth/callback'.length) || this.requestOrigin(req)
        : configured;
    }
    return this.requestOrigin(req) + (this.config.clientBasePath || '');
  }

  private frontendRedirectUri(req: RequestOriginSource): string {
    return this.redirectUri(req);
  }

  createOAuthFrontendRedirect(req: RequestOriginSource, code: string, state: string): string {
    const location = new URL(this.frontendRedirectUri(req));
    location.searchParams.set('code', code);
    location.searchParams.set('state', state);
    return location.toString();
  }

  createAuthorizeUrl(req: Request): string {
    const nonce = randomBytes(24).toString('base64url');
    const createdAt = Date.now().toString();
    const statePayload = `${nonce}.${createdAt}`;
    const state = `${statePayload}.${createHmac('sha256', this.key).update(statePayload).digest('base64url')}`;
    const query = new URLSearchParams({
      app_id: this.config.appId,
      redirect_uri: this.redirectUri(req),
      scope: this.config.oauthScopes,
      state,
    });
    return `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${query}`;
  }

  async completeOAuth(req: Request, res: Response, code: string, state: string): Promise<string> {
    const [nonce = '', createdAt = '', signature = ''] = state.split('.');
    const statePayload = `${nonce}.${createdAt}`;
    const expected = createHmac('sha256', this.key).update(statePayload).digest('base64url');
    const signatureBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    const stateAge = Date.now() - Number(createdAt);
    if (!nonce || !Number.isFinite(stateAge) || stateAge < 0 || stateAge > 10 * 60 * 1000 || signatureBytes.length !== expectedBytes.length || !timingSafeEqual(signatureBytes, expectedBytes)) {
      throw new HttpException('飞书授权状态已失效，请返回插件重新授权', HttpStatus.BAD_REQUEST);
    }
    const response = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        code,
        redirect_uri: this.redirectUri(req),
      }),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok || payload.code) throw new HttpException(String(payload.error_description || payload.msg || '飞书授权失败'), HttpStatus.BAD_GATEWAY);
    const token = this.toToken(payload);
    const userKey = this.userKey(req);
    if (userKey) this.userTokens.set(userKey, token);
    this.writeToken(res, token);
    return this.seal(token);
  }

  private toToken(payload: Record<string, unknown>): OAuthToken {
    const now = Date.now();
    return {
      accessToken: String(payload.access_token || ''),
      refreshToken: String(payload.refresh_token || ''),
      expiresAt: now + Number(payload.expires_in || 0) * 1000,
      refreshExpiresAt: now + Number(payload.refresh_token_expires_in || 0) * 1000,
    };
  }

  private writeToken(res: Response, token: OAuthToken) {
    const maxAge = Math.max(60_000, token.refreshExpiresAt - Date.now());
    res.cookie(this.tokenCookie, this.seal(token), this.cookieOptions(maxAge));
  }

  async userToken(req: Request, res: Response, required = true): Promise<string | null> {
    const headerSession = req.get('x-approval-session') || '';
    const userKey = this.userKey(req);
    let token = this.unseal<OAuthToken>(headerSession) || this.unseal<OAuthToken>(this.cookies(req)[this.tokenCookie]) || (userKey ? this.userTokens.get(userKey) : undefined);
    if (!token || token.refreshExpiresAt <= Date.now()) {
      if (userKey) this.userTokens.delete(userKey);
      if (required) throw new HttpException('请先授权飞书身份', HttpStatus.UNAUTHORIZED);
      return null;
    }
    if (token.expiresAt <= Date.now() + 60_000) {
      const response = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: this.config.appId,
          client_secret: this.config.appSecret,
          refresh_token: token.refreshToken,
        }),
      });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok || payload.code) {
        if (userKey) this.userTokens.delete(userKey);
        res.clearCookie(this.tokenCookie, { path: '/' });
        if (required) throw new HttpException('飞书授权已过期，请重新授权', HttpStatus.UNAUTHORIZED);
        return null;
      }
      token = this.toToken(payload);
      if (userKey) this.userTokens.set(userKey, token);
      this.writeToken(res, token);
    }
    if (headerSession) res.setHeader('X-Approval-Session', this.seal(token));
    return token.accessToken;
  }

  async tenantAccessToken(): Promise<string> {
    if (this.tenantToken && this.tenantToken.expiresAt > Date.now() + 60_000) return this.tenantToken.value;
    const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
    });
    const payload = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!response.ok || payload.code || !payload.tenant_access_token) throw new Error(payload.msg || '获取应用访问凭证失败');
    this.tenantToken = { value: payload.tenant_access_token, expiresAt: Date.now() + Number(payload.expire || 7200) * 1000 };
    return this.tenantToken.value;
  }

  async api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`https://open.feishu.cn/open-apis/${path.replace(/^\//, '')}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
    const payload = await response.json() as FeishuEnvelope<T>;
    if (!response.ok || (typeof payload.code === 'number' && payload.code !== 0)) {
      throw new Error(payload.msg || `飞书接口请求失败（${response.status}）`);
    }
    return (payload.data ?? payload) as T;
  }

  async download(urlPath: string, token: string): Promise<{ buffer: Buffer; contentType: string }> {
    const response = await fetch(`https://open.feishu.cn/open-apis/${urlPath.replace(/^\//, '')}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`附件下载失败（${response.status}）`);
    return { buffer: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || 'application/octet-stream' };
  }

  async downloadExternalFile(url: string): Promise<{ buffer: Buffer; contentType: string }> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`approval attachment download failed (${response.status})`);
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || 'application/octet-stream',
    };
  }

  async uploadBaseMedia(
    token: string,
    baseAppToken: string,
    input: { fileName: string; buffer: Buffer; contentType: string },
  ): Promise<{ fileToken: string }> {
    const parentType = input.contentType.startsWith('image/') ? 'bitable_image' : 'bitable_file';
    const form = new FormData();
    form.set('file_name', input.fileName);
    form.set('parent_type', parentType);
    form.set('parent_node', baseAppToken);
    form.set('size', String(input.buffer.byteLength));
    form.set('file', new Blob([new Uint8Array(input.buffer)], { type: input.contentType }), input.fileName);
    const response = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const payload = await response.json() as { code?: number; msg?: string; data?: { file_token?: string } };
    if (!response.ok || payload.code || !payload.data?.file_token) {
      throw new Error(payload.msg || `审批附件上传失败（${response.status}）`);
    }
    return { fileToken: payload.data.file_token };
  }
}
