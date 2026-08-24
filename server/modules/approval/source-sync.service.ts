import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  BasePluginSourceConfiguration,
  SourceSyncState,
} from '../../../shared/approval';
import { FeishuService } from './feishu.service';

interface InstanceListResponse {
  instance_code_list?: string[];
  has_more?: boolean;
  page_token?: string;
}

interface ApprovalInstanceDetail {
  instance_code?: string;
  approval_code?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  form?: string | unknown[];
}

interface ApprovalFormItem {
  id?: string;
  type?: string;
  value?: unknown;
}

interface ApprovalAttachmentValue {
  url?: string;
  name?: string;
  ext?: string;
}

interface BaseRecordItem {
  record_id?: string;
}

interface BaseRecordListResponse {
  items?: BaseRecordItem[];
  has_more?: boolean;
  page_token?: string;
}

export interface SourceSyncResult {
  sourceApprovalCode: string;
  syncedCount: number;
  skippedCount: number;
  syncState: SourceSyncState;
}

@Injectable()
export class SourceSyncService {
  constructor(private readonly feishu: FeishuService) {}

  async sync(
    token: string,
    configuration: BasePluginSourceConfiguration,
  ): Promise<SourceSyncResult> {
    const endTime = new Date();
    const startTime = this.syncStartTime(configuration.syncState, endTime);
    const instanceCodes = await this.listInstanceCodes(
      token,
      configuration.sourceTableBinding.sourceApprovalCode,
      startTime,
      endTime,
    );
    let syncedCount = 0;
    let skippedCount = 0;

    for (const instanceCode of instanceCodes) {
      const detail = await this.readInstanceDetail(token, instanceCode);
      if (!detail.status || !configuration.syncPolicy.acceptedStatuses.includes(detail.status)) {
        skippedCount += 1;
        continue;
      }
      const fields = await this.buildRecordFields(token, detail, configuration);
      await this.upsertRecord(
        token,
        configuration.sourceTableBinding.baseAppToken,
        configuration.sourceTableBinding.baseTableId,
        instanceCode,
        fields,
      );
      syncedCount += 1;
    }

    return {
      sourceApprovalCode: configuration.sourceTableBinding.sourceApprovalCode,
      syncedCount,
      skippedCount,
      syncState: {
        lastSyncAt: new Date().toISOString(),
        lastStartTime: startTime.toISOString(),
        lastEndTime: endTime.toISOString(),
        lastSyncedCount: syncedCount,
        lastSkippedCount: skippedCount,
      },
    };
  }

  private syncStartTime(state: SourceSyncState | undefined, endTime: Date): Date {
    const tenHoursAgo = endTime.getTime() - 10 * 60 * 60 * 1000;
    const previousEnd = state?.lastEndTime ? Date.parse(state.lastEndTime) : Number.NaN;
    const candidate = Number.isNaN(previousEnd) ? tenHoursAgo : previousEnd - 60 * 1000;
    return new Date(Math.max(tenHoursAgo, candidate));
  }

  private async listInstanceCodes(
    token: string,
    approvalCode: string,
    startTime: Date,
    endTime: Date,
  ): Promise<string[]> {
    const codes: string[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        approval_code: approvalCode,
        start_time: String(startTime.getTime()),
        end_time: String(endTime.getTime()),
        page_size: '100',
      });
      if (pageToken) query.set('page_token', pageToken);
      const response = await this.feishu.api<InstanceListResponse>(
        `approval/v4/instances?${query.toString()}`,
        token,
      );
      codes.push(...(response.instance_code_list || []));
      pageToken = response.has_more ? response.page_token : undefined;
      if (response.has_more && !pageToken) {
        throw new Error(`读取审批实例分页失败：${approvalCode}`);
      }
    } while (pageToken);
    return [...new Set(codes)];
  }

  private async readInstanceDetail(
    token: string,
    instanceCode: string,
  ): Promise<ApprovalInstanceDetail> {
    return this.feishu.api<ApprovalInstanceDetail>(
      `approval/v4/instances/detail?${new URLSearchParams({
        instance_code: instanceCode,
        locale: 'zh-CN',
        user_id_type: 'open_id',
      })}`,
      token,
    );
  }

  private async buildRecordFields(
    token: string,
    detail: ApprovalInstanceDetail,
    configuration: BasePluginSourceConfiguration,
  ): Promise<Record<string, unknown>> {
    const instanceCode = detail.instance_code?.trim();
    if (!instanceCode) throw new BadRequestException('审批实例详情缺少 instance_code');
    const fields: Record<string, unknown> = {
      [configuration.sourceTableBinding.systemFields.instanceCodeFieldId]: instanceCode,
      [configuration.sourceTableBinding.systemFields.statusFieldId]: detail.status || '',
      [configuration.sourceTableBinding.systemFields.submittedAtFieldId]: this.timestamp(
        detail.start_time,
      ),
      [configuration.sourceTableBinding.systemFields.syncedAtFieldId]: Date.now(),
    };
    const formItems = this.formItems(detail.form);
    for (const binding of configuration.syncedFieldBindings) {
      const item = formItems.find(
        (candidate: ApprovalFormItem) => candidate.id === binding.sourceControlId,
      );
      if (!item) continue;
      const value = await this.sourceFieldValue(
        token,
        configuration.sourceTableBinding.baseAppToken,
        item.value,
        binding.sourceControlType,
      );
      if (value !== undefined) fields[binding.baseFieldId] = value;
    }
    return fields;
  }

  private async sourceFieldValue(
    token: string,
    baseAppToken: string,
    value: unknown,
    controlType: string,
  ): Promise<unknown> {
    const type = controlType.trim().toLowerCase().replace(/[-_]/gu, '');
    if (type === 'attachment' || type === 'attachmentv2' || type === 'image' || type === 'imagev2') {
      return this.attachmentValue(token, baseAppToken, value);
    }
    return sourceValue(value, controlType);
  }

  private async attachmentValue(
    token: string,
    baseAppToken: string,
    value: unknown,
  ): Promise<Array<{ file_token: string }> | undefined> {
    if (!Array.isArray(value)) return undefined;
    const attachments = value.filter((item): item is ApprovalAttachmentValue => {
      if (!item || typeof item !== 'object') return false;
      return typeof (item as ApprovalAttachmentValue).url === 'string';
    });
    if (!attachments.length) return undefined;
    const uploaded: Array<{ file_token: string }> = [];
    for (const attachment of attachments) {
      const file = await this.feishu.downloadExternalFile(attachment.url as string);
      if (file.buffer.byteLength > 20 * 1024 * 1024) {
        throw new Error('审批附件超过 Base 上传限制（20MB）');
      }
      const result = await this.feishu.uploadBaseMedia(token, baseAppToken, {
        fileName: attachmentFileName(attachment),
        buffer: file.buffer,
        contentType: file.contentType,
      });
      uploaded.push({ file_token: result.fileToken });
    }
    return uploaded;
  }

  private formItems(form: string | unknown[] | undefined): ApprovalFormItem[] {
    const parsed: unknown = typeof form === 'string' ? this.parseJson(form) : form;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item: unknown): item is ApprovalFormItem => {
      if (!item || typeof item !== 'object') return false;
      const object = item as Record<string, unknown>;
      return typeof object.id === 'string';
    });
  }

  private parseJson(value: string): unknown {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }

  private timestamp(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const timestamp = Number(value);
    if (Number.isFinite(timestamp)) return timestamp;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private async upsertRecord(
    token: string,
    baseToken: string,
    tableId: string,
    instanceCode: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const existing = await this.findRecord(token, baseToken, tableId, instanceCode);
    const path = existing
      ? `bitable/v1/apps/${baseToken}/tables/${tableId}/records/${existing}`
      : `bitable/v1/apps/${baseToken}/tables/${tableId}/records`;
    await this.feishu.api(path, token, {
      method: existing ? 'PUT' : 'POST',
      body: JSON.stringify({ fields }),
    });
  }

  private async findRecord(
    token: string,
    baseToken: string,
    tableId: string,
    instanceCode: string,
  ): Promise<string | undefined> {
    const filterValue = instanceCode.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
    const query = new URLSearchParams({
      page_size: '100',
      filter: `CurrentValue.[审批实例编号] = "${filterValue}"`,
    });
    const response = await this.feishu.api<BaseRecordListResponse>(
      `bitable/v1/apps/${baseToken}/tables/${tableId}/records?${query.toString()}`,
      token,
    );
    return response.items?.find(
      (item: BaseRecordItem) => typeof item.record_id === 'string',
    )?.record_id;
  }
}

function sourceValue(value: unknown, controlType: string): unknown {
  if (value === null || value === undefined) return undefined;
  const type = controlType.trim().toLowerCase().replace(/[-_]/gu, '');
  if (type === 'checkbox' || type === 'checkboxv2') {
    return value === true || value === 'true' || value === 1;
  }
  if (type === 'date' || type === 'datetime') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return value;
}

function attachmentFileName(attachment: ApprovalAttachmentValue): string {
  if (attachment.name?.trim()) return attachment.name.trim();
  const extension = parseExtension(attachment.ext);
  return extension ? `approval-attachment.${extension}` : 'approval-attachment';
}

function parseExtension(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(`[${value}]`) as unknown[];
    const first = parsed.find((item): item is string => typeof item === 'string');
    return first?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export { sourceValue };
