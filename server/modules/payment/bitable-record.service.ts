import { BadRequestException, Injectable } from '@nestjs/common';
import type { TargetTableBindingResponse, TargetWriteBackFieldBindings } from '../../../shared/approval';
import { FeishuService } from './feishu.service';

export type BitableFieldMeta = {
  fieldId: string;
  fieldName: string;
  type: number;
  uiType?: string;
};

export type BitableRecord = {
  recordId: string;
  fields: Record<string, unknown>;
};

type BitableFieldListResponse = {
  items?: Array<{
    field_id?: string;
    field_name?: string;
    type?: number;
    ui_type?: string;
  }>;
  has_more?: boolean;
  page_token?: string;
};

type BitableRecordResponse = {
  record?: {
    record_id?: string;
    fields?: Record<string, unknown>;
  };
};

@Injectable()
export class BitableRecordService {
  constructor(private readonly feishu: FeishuService) {}

  async listFields(token: string, baseToken: string, tableId: string): Promise<BitableFieldMeta[]> {
    const result: BitableFieldMeta[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const response = await this.feishu.api<BitableFieldListResponse>(
        `bitable/v1/apps/${baseToken}/tables/${tableId}/fields?${query}`,
        token,
      );
      for (const item of response.items || []) {
        if (!item.field_id || !item.field_name || typeof item.type !== 'number') continue;
        result.push({
          fieldId: item.field_id,
          fieldName: item.field_name,
          type: item.type,
          ...(item.ui_type ? { uiType: item.ui_type } : {}),
        });
      }
      pageToken = response.has_more ? response.page_token : undefined;
      if (response.has_more && !pageToken) {
        throw new Error(`读取多维表格字段分页失败：${tableId}`);
      }
    } while (pageToken);
    return result;
  }

  async readRecords(
    token: string,
    baseToken: string,
    tableId: string,
    recordIds: string[],
  ): Promise<BitableRecord[]> {
    const records: BitableRecord[] = [];
    for (const recordId of recordIds) {
      try {
        const response = await this.feishu.api<BitableRecordResponse>(
          `bitable/v1/apps/${baseToken}/tables/${tableId}/records/${recordId}`,
          token,
        );
        const record = response.record;
        if (!record?.record_id || !record.fields) {
          throw new Error('记录响应缺少 record_id 或 fields');
        }
        records.push({ recordId: record.record_id, fields: record.fields });
      } catch (error) {
        throw new BadRequestException(
          `记录 ${recordId} 不存在或当前用户无权访问：${this.errorMessage(error)}`,
        );
      }
    }
    return records;
  }

  resolveField(
    fields: BitableFieldMeta[],
    fieldId: string,
    context: string,
  ): BitableFieldMeta {
    const field = fields.find((item) => item.fieldId === fieldId);
    if (!field) {
      throw new BadRequestException(`${context}引用的多维表格字段 ${fieldId} 不存在`);
    }
    return field;
  }

  fieldValue(record: BitableRecord, field: BitableFieldMeta, context: string): unknown {
    void context;
    return record.fields[field.fieldName];
  }

  async writeBack(
    token: string,
    baseToken: string,
    tableBinding: TargetTableBindingResponse,
    writeBackFields: TargetWriteBackFieldBindings,
    fields: BitableFieldMeta[],
    recordId: string,
    values: {
      instanceCode: string;
      approvalStatus: string;
      submittedAt: string;
      batchId: string;
    },
  ): Promise<void> {
    const mapping: Array<[keyof TargetWriteBackFieldBindings, unknown]> = [
      ['instanceCodeFieldId', values.instanceCode],
      ['statusFieldId', values.approvalStatus],
      ['submittedAtFieldId', this.toTimestamp(values.submittedAt)],
      ['batchIdFieldId', values.batchId],
    ];
    const patch: Record<string, unknown> = {};
    for (const [key, value] of mapping) {
      const field = this.resolveField(
        fields,
        writeBackFields[key],
        `目标审批 ${tableBinding.targetApprovalCode} 的回写配置`,
      );
      patch[field.fieldName] = value;
    }
    try {
      await this.feishu.api(
        `bitable/v1/apps/${baseToken}/tables/${tableBinding.baseTableId}/records/${recordId}`,
        token,
        { method: 'PUT', body: JSON.stringify({ fields: patch }) },
      );
    } catch (error) {
      throw new Error(`记录 ${recordId} 回写失败：${this.errorMessage(error)}`);
    }
  }

  attachmentEntries(value: unknown): Array<{ fileToken: string; name: string; size: number }> {
    const items = Array.isArray(value) ? value : [value];
    return items.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const object = item as Record<string, unknown>;
      const fileToken = String(object.file_token || object.fileToken || object.token || '').trim();
      if (!fileToken) return [];
      return [{
        fileToken,
        name: String(object.name || object.file_name || fileToken),
        size: Number(object.size || 0),
      }];
    });
  }

  private toTimestamp(value: string): number {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) throw new Error(`提交时间无法转换为时间戳：${value}`);
    return timestamp;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
