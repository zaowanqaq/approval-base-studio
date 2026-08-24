import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export function extractBaseToken(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new BadRequestException('多维表格链接格式不正确');
  }

  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith('.feishu.cn') && !host.endsWith('.larksuite.com')) {
    throw new BadRequestException('多维表格链接必须来自飞书或 Lark');
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const baseIndex = segments.findIndex((segment: string) => segment === 'base');
  const baseToken = baseIndex >= 0 ? segments[baseIndex + 1] : undefined;
  if (!baseToken) {
    throw new BadRequestException('多维表格链接中缺少表格标识');
  }
  return baseToken;
}

export function baseReferenceFromUrl(baseUrl: string): string {
  const baseToken = extractBaseToken(baseUrl);
  return createHash('sha256').update(baseToken).digest('hex');
}
