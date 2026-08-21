import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { FeishuService } from './feishu.service';

export type ApprovalInstanceCreated = {
  instance_code: string;
  instance_link?: string;
};

@Injectable()
export class ApprovalSubmissionService {
  constructor(private readonly feishu: FeishuService) {}

  async uploadFile(
    buffer: Buffer,
    name: string,
    contentType = 'application/octet-stream',
    uploadType = 'attachment',
  ): Promise<string> {
    const tenantToken = await this.feishu.tenantAccessToken();
    const boundary = `----ApprovalConsole${randomBytes(12).toString('hex')}`;
    const safeName = name.replace(/["\r\n]/gu, '_');
    const namePart = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${safeName}\r\n`,
      'utf8',
    );
    const typePart = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${uploadType}\r\n`,
      'utf8',
    );
    const contentHeader = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="${safeName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      'utf8',
    );
    const ending = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([
      namePart,
      typePart,
      contentHeader,
      Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
      ending,
    ]);
    const response = await fetch(
      'https://open.feishu.cn/approval/openapi/v2/file/upload',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantToken}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      },
    );
    const payload = (await response.json()) as {
      code?: number;
      msg?: string;
      data?: { code?: string };
    };
    const fileCode = payload.data?.code;
    if (!response.ok || payload.code || !fileCode) {
      throw new Error(payload.msg || `审批附件上传失败：${safeName}`);
    }
    return fileCode;
  }

  initiate(
    token: string,
    approvalCode: string,
    form: Array<Record<string, unknown>>,
    uuid: string,
  ): Promise<ApprovalInstanceCreated> {
    return this.initiateWithOfficialEndpoint(token, approvalCode, form, uuid);
  }

  private async initiateWithOfficialEndpoint(
    userToken: string,
    approvalCode: string,
    form: Array<Record<string, unknown>>,
    uuid: string,
  ): Promise<ApprovalInstanceCreated> {
    const user = await this.feishu.api<{ open_id?: string }>(
      'authen/v1/user_info',
      userToken,
    );
    const openId = user.open_id?.trim();
    if (!openId) throw new Error('无法获取当前操作人的 open_id，不能发起审批');
    const tenantToken = await this.feishu.tenantAccessToken();
    return this.feishu.api<ApprovalInstanceCreated>(
      'approval/v4/instances',
      tenantToken,
      {
        method: 'POST',
        body: JSON.stringify({
          approval_code: approvalCode,
          open_id: openId,
          form: JSON.stringify(form),
          uuid,
        }),
      },
    );
  }

  async serialNumber(token: string, instanceCode: string): Promise<string | null> {
    try {
      const detail = await this.feishu.api<{ serial_number?: string }>(
        `approval/v4/instances/detail?${new URLSearchParams({
          instance_code: instanceCode,
          locale: 'zh-CN',
        })}`,
        token,
      );
      return detail.serial_number || null;
    } catch {
      return null;
    }
  }
}
