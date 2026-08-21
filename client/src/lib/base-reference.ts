export function extractBaseToken(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith('.feishu.cn') && !host.endsWith('.larksuite.com')) {
    throw new Error('Base URL 必须来自飞书或 Lark');
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const baseIndex = segments.findIndex((segment) => segment === 'base');
  const baseToken = baseIndex >= 0 ? segments[baseIndex + 1] : undefined;
  if (!baseToken) throw new Error('Base URL 中缺少 Base 标识');
  return baseToken;
}
