import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
  ApprovalSchemaSchema,
  TargetFieldSourceInputSchema,
  TargetProvisioningRequestSchema,
  TargetProvisioningResultSchema,
  TargetTableDestinationSchema,
} from '../../../shared/approval';
import { isComputedApprovalControl } from '../../../shared/approval';
import type {
  ApprovalControl,
  ApprovalSchema,
  TargetFieldBinding,
  TargetFieldAtomicSource,
  TargetFieldAtomicSourceInput,
  TargetFieldSource,
  TargetFieldSourceInput,
  TargetProvisioningRequest,
  TargetProvisioningResult,
  TargetTableDestination,
  TargetWriteBackFieldBindings,
  BasePluginTargetConfiguration,
} from '../../../shared/approval';
import {
  ApprovalSchemaService,
  approvalSchemaFingerprint,
} from './approval-schema.service';
import {
  approvalFieldMapping,
  type ApprovalFieldMapping,
} from './approval-field-mapping';
import { extractBaseToken } from './base-reference';
import { FeishuService } from './feishu.service';

interface FeishuCreateTableResponse {
  table_id?: string;
}

interface FeishuListTableResponse {
  items?: Array<{
    table_id?: string;
    name?: string;
  }>;
  has_more?: boolean;
  page_token?: string;
}

interface FeishuCreateFieldResponse {
  field?: {
    field_id?: string;
  };
}

interface FeishuListFieldResponse {
  items?: Array<{
    field_id?: string;
    field_name?: string;
    type?: number;
  }>;
  has_more?: boolean;
  page_token?: string;
}

const TARGET_SYSTEM_FIELD_DEFINITIONS = [
  { key: 'instanceCodeFieldId', name: '审批实例编号', apiType: 1 },
  { key: 'statusFieldId', name: '审批状态', apiType: 1 },
  { key: 'submittedAtFieldId', name: '提交时间', apiType: 5 },
  { key: 'batchIdFieldId', name: '批次ID', apiType: 1 },
] as const;

@Injectable()
export class TargetProvisioningService {
  constructor(
    private readonly feishu: FeishuService,
    private readonly approvalSchemas: ApprovalSchemaService,
  ) {}

  async provision(
    token: string,
    input: unknown,
  ): Promise<TargetProvisioningResult> {
    const request: TargetProvisioningRequest =
      TargetProvisioningRequestSchema.parse(input) as TargetProvisioningRequest;
    const rawSchema = await this.approvalSchemas.readApprovalSchema(
      token,
      request.approvalCode,
    );
    const schema: ApprovalSchema =
      ApprovalSchemaSchema.parse(rawSchema) as ApprovalSchema;
    return this.provisionSchema(
      token,
      schema,
      request.destination,
      request.fieldSources,
    );
  }

  async provisionSchema(
    token: string,
    schema: ApprovalSchema,
    destination: TargetTableDestination,
    fieldSources: Record<string, TargetFieldSourceInput> = {},
  ): Promise<TargetProvisioningResult> {
    const validatedSchema: ApprovalSchema =
      ApprovalSchemaSchema.parse(schema) as ApprovalSchema;
    const validatedDestination: TargetTableDestination =
      TargetTableDestinationSchema.parse(
        destination,
      ) as TargetTableDestination;
    const validatedFieldSources = z
      .record(z.string(), TargetFieldSourceInputSchema)
      .parse(fieldSources) as Record<string, TargetFieldSourceInput>;
    const provisionableSchema: ApprovalSchema = {
      ...validatedSchema,
      controls: validatedSchema.controls.filter(
        (control: ApprovalControl) => !isComputedApprovalControl(control),
      ),
    };
    this.validateSchema(provisionableSchema);
    const controlIds = new Set(validatedSchema.controls.map((control) => control.id));
    for (const controlId of Object.keys(validatedFieldSources)) {
      if (!controlIds.has(controlId)) {
        throw new BadRequestException(`字段来源配置引用了不存在的审批控件 ${controlId}`);
      }
    }

    const baseAppToken = extractBaseToken(validatedDestination.baseUrl);
    const tableName = this.resolveTableName(
      validatedSchema,
      validatedDestination.tableName,
    );
    const tableId = await this.createTable(
      token,
      baseAppToken,
      tableName,
    );

    const targetFieldBindings: TargetFieldBinding[] = [];
    for (const control of provisionableSchema.controls) {
      const mapping = this.mappingFor(control);
      const fieldId = await this.createField(
        token,
        baseAppToken,
        tableId,
        control.name.trim(),
        mapping,
      );
      const source = this.resolveFieldSource(
        validatedFieldSources[control.id],
        tableId,
        fieldId,
      );
      this.validateFieldSource(control, source);
      targetFieldBindings.push({
        targetApprovalCode: validatedSchema.approvalCode,
        targetControlId: control.id,
        targetControlName: control.name.trim(),
        targetControlType: control.type,
        baseTableId: tableId,
        baseFieldId: fieldId,
        baseFieldName: control.name.trim(),
        baseFieldType: mapping.baseFieldType,
        source,
      });
    }

    const writeBackFields = await this.createSystemFields(
      token,
      baseAppToken,
      tableId,
    );
    const result: TargetProvisioningResult = {
      targetTableBinding: {
        targetApprovalCode: validatedSchema.approvalCode,
        baseAppToken,
        baseTableId: tableId,
        baseTableName: tableName,
        writeBackFields,
        baseUrl: validatedDestination.baseUrl,
      },
      targetFieldBindings,
      approvalSchemaFingerprint:
        validatedSchema.schemaFingerprint || approvalSchemaFingerprint(validatedSchema),
    };
    return TargetProvisioningResultSchema.parse(
      result,
    ) as TargetProvisioningResult;
  }

  async updateFieldSources(
    token: string,
    baseUrl: string,
    target: BasePluginTargetConfiguration,
    fieldSources: Record<string, TargetFieldSourceInput>,
  ): Promise<TargetProvisioningResult> {
    const rawSchema = await this.approvalSchemas.readApprovalSchema(
      token,
      target.targetTableBinding.targetApprovalCode,
    );
    const schema = ApprovalSchemaSchema.parse(rawSchema) as ApprovalSchema;
    this.validateSchema(schema);
    const validatedSources = z
      .record(z.string(), TargetFieldSourceInputSchema)
      .parse(fieldSources) as Record<string, TargetFieldSourceInput>;
    const controls = new Map<string, ApprovalControl>(
      schema.controls.map((control: ApprovalControl) => [control.id, control]),
    );
    const bindings = target.targetFieldBindings.map((binding: TargetFieldBinding) => {
      const sourceInput = validatedSources[binding.targetControlId];
      if (!sourceInput) return binding;
      const source = this.resolveFieldSource(
        sourceInput,
        target.targetTableBinding.baseTableId,
        binding.baseFieldId,
      );
      const control = controls.get(binding.targetControlId);
      if (!control) throw new BadRequestException(`字段来源配置引用了不存在的审批控件 ${binding.targetControlId}`);
      if (source.kind === 'base-field' && source.baseTableId !== target.targetTableBinding.baseTableId) {
        throw new BadRequestException(`审批控件 ${control.id} 暂不支持跨数据表字段来源`);
      }
      this.validateFieldSource(control, source);
      return { ...binding, source };
    });
    return TargetProvisioningResultSchema.parse({
      targetTableBinding: {
        ...target.targetTableBinding,
        baseAppToken: extractBaseToken(baseUrl),
        baseUrl,
      },
      targetFieldBindings: bindings,
      approvalSchemaFingerprint: schema.schemaFingerprint || approvalSchemaFingerprint(schema),
    }) as TargetProvisioningResult;
  }

  private validateSchema(schema: ApprovalSchema): void {
    if (schema.controls.length === 0) {
      throw new BadRequestException('审批流没有可创建的顶层控件');
    }

    const names = new Set<string>();
    for (const control of schema.controls) {
      if (control.children?.length) {
        throw new BadRequestException(
          `审批控件“${control.name || control.id}”包含明细，当前阶段暂不自动展平明细表`,
        );
      }
      if (!control.name.trim()) {
        throw new BadRequestException(`审批控件 ${control.id} 缺少展示名称`);
      }
      const nameKey = control.name.trim().replace(/\s+/gu, '').toLowerCase();
      if (names.has(nameKey)) {
        throw new BadRequestException(
          `审批流存在重复控件名称“${control.name.trim()}”，无法安全创建字段`,
        );
      }
      names.add(nameKey);
      this.mappingFor(control);
    }

    const systemNames = new Set(
      TARGET_SYSTEM_FIELD_DEFINITIONS.map((definition) =>
        definition.name.replace(/\s+/gu, '').toLowerCase(),
      ),
    );
    for (const name of names) {
      if (systemNames.has(name)) {
        throw new BadRequestException('审批控件名称与提审系统字段冲突');
      }
    }
  }

  private mappingFor(control: ApprovalControl): ApprovalFieldMapping {
    const mapping = approvalFieldMapping(control);
    if (!mapping) {
      throw new BadRequestException(
        `暂不支持将审批控件类型“${control.type}”自动创建为多维表格字段`,
      );
    }
    return mapping;
  }

  private resolveFieldSource(
    input: TargetFieldSourceInput | undefined,
    tableId: string,
    fieldId: string,
  ): TargetFieldSource {
    if (!input) {
      return {
        kind: 'base-field',
        baseTableId: tableId,
        baseFieldId: fieldId,
      };
    }
    if (input.kind === 'base-field') {
      return {
        kind: 'base-field',
        baseTableId: input.baseTableId || tableId,
        baseFieldId: input.baseFieldId,
      };
    }
    if (input.kind === 'template') {
      return {
        kind: 'template',
        parts: input.parts.map((part) => part.kind === 'literal'
          ? part
          : { kind: 'source', source: this.resolveAtomicSource(part.source, tableId) }),
      };
    }
    if (input.kind === 'calculation') {
      return {
        kind: 'calculation',
        operation: input.operation,
        operands: input.operands.map((operand: TargetFieldAtomicSourceInput) =>
          this.resolveAtomicSource(operand, tableId)),
        scale: input.scale ?? 2,
        rounding: input.rounding ?? 'half-up',
      };
    }
    if (input.kind === 'attachment-merge') {
      return {
        kind: 'attachment-merge',
        sources: input.sources.map((source: TargetFieldAtomicSourceInput) =>
          this.resolveAtomicSource(source, tableId)),
      };
    }
    return input;
  }

  private resolveAtomicSource(
    input: TargetFieldAtomicSourceInput,
    tableId: string,
  ): TargetFieldAtomicSource {
    if (input.kind === 'base-field') {
      return {
        kind: 'base-field',
        baseTableId: input.baseTableId || tableId,
        baseFieldId: input.baseFieldId,
      };
    }
    return input;
  }

  private validateFieldSource(control: ApprovalControl, source: TargetFieldSource): void {
    const key = control.type.trim().toLowerCase().replace(/[-_]/gu, '');
    const textControl = ['text', 'input', 'phone', 'url', 'textarea'].includes(key);
    const numericControl = ['number', 'amount'].includes(key);
    const dateControl = ['date', 'datetime'].includes(key);
    const attachmentControl = ['attachment', 'attachmentv2', 'image', 'imagev2'].includes(key);
    if (source.kind === 'template' && !textControl) {
      throw new BadRequestException(`审批控件 ${control.id} 的模板来源仅支持文本控件`);
    }
    if (source.kind === 'calculation' && !numericControl) {
      throw new BadRequestException(`审批控件 ${control.id} 的计算来源仅支持数字或金额控件`);
    }
    if (source.kind === 'attachment-merge' && !attachmentControl) {
      throw new BadRequestException(`审批控件 ${control.id} 的附件合并来源仅支持附件或图片控件`);
    }
    if (source.kind === 'current-time' && !dateControl) {
      throw new BadRequestException(`审批控件 ${control.id} 的当前时间来源仅支持日期/时间控件`);
    }
    if (source.kind === 'current-operator' && !['contact', 'user'].includes(key)) {
      throw new BadRequestException(`审批控件 ${control.id} 的当前操作人来源仅支持人员控件`);
    }
    if (source.kind === 'manual') {
      if (source.inputType === 'attachment' && !attachmentControl) {
        throw new BadRequestException(`审批控件 ${control.id} 的附件输入只能用于附件或图片控件`);
      }
      if (['number', 'amount'].includes(source.inputType) && !numericControl) {
        throw new BadRequestException(`审批控件 ${control.id} 的数字输入只能用于数字或金额控件`);
      }
      if (source.inputType === 'date-time' && !dateControl) {
        throw new BadRequestException(`审批控件 ${control.id} 的日期输入只能用于日期/时间控件`);
      }
    }
  }

  private resolveTableName(
    schema: ApprovalSchema,
    requestedName?: string,
  ): string {
    const tableName = requestedName?.trim() || `${schema.approvalName.trim()}-提审`;
    if (!tableName || tableName.length > 100 || /[\\/?*:[\]]/u.test(tableName)) {
      throw new BadRequestException(
        '提审数据表名称不能为空、不能超过 100 个字符且不能包含 / \\ ? * : [ ]',
      );
    }
    return tableName;
  }

  private async createTable(
    token: string,
    baseAppToken: string,
    tableName: string,
  ): Promise<string> {
    try {
      const response = await this.feishu.api<FeishuCreateTableResponse>(
        `bitable/v1/apps/${baseAppToken}/tables`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            table: {
              name: tableName,
              default_view_name: '主视图',
            },
          }),
        },
      );
      if (!response.table_id) {
        throw new Error('飞书创建提审数据表成功但未返回数据表标识');
      }
      return response.table_id;
    } catch (error) {
      // 创建请求可能已经在网络层成功，但客户端没有收到响应。只复用同时
      // 带有插件回写标记字段的同名表，避免误修改用户手工创建的同名数据表。
      try {
        const existing = await this.findRecoverableTable(token, baseAppToken, tableName);
        if (existing) return existing;
      } catch {
        // 保留创建请求的原始错误，避免查询恢复状态失败掩盖权限或网络原因。
      }
      throw error;
    }
  }

  private async createField(
    token: string,
    baseAppToken: string,
    tableId: string,
    fieldName: string,
    mapping: ApprovalFieldMapping,
  ): Promise<string> {
    try {
      const response = await this.feishu.api<FeishuCreateFieldResponse>(
        `bitable/v1/apps/${baseAppToken}/tables/${tableId}/fields`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ field_name: fieldName, type: mapping.apiType }),
        },
      );
      const fieldId = response.field?.field_id;
      if (!fieldId) {
        throw new Error(`飞书创建字段“${fieldName}”成功但未返回字段标识`);
      }
      return fieldId;
    } catch (error) {
      try {
        const existing = await this.findFieldByName(
          token,
          baseAppToken,
          tableId,
          fieldName,
        );
        if (existing) {
          if (existing.type !== mapping.apiType) {
            throw new BadRequestException(
              `提审字段“${fieldName}”已存在但类型不兼容，无法安全恢复创建`,
            );
          }
          return existing.fieldId;
        }
      } catch (recoveryError) {
        if (recoveryError instanceof BadRequestException) throw recoveryError;
        // 保留字段创建请求的原始错误，避免恢复查询失败掩盖权限或网络原因。
      }
      throw error;
    }
  }

  private async findTableByName(
    token: string,
    baseAppToken: string,
    tableName: string,
  ): Promise<string | undefined> {
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const response = await this.feishu.api<FeishuListTableResponse>(
        `bitable/v1/apps/${baseAppToken}/tables?${query}`,
        token,
      );
      const match = (response.items || []).find(
        (item) => item.table_id && item.name === tableName,
      );
      if (match?.table_id) return match.table_id;
      pageToken = response.has_more ? response.page_token : undefined;
      if (response.has_more && !pageToken) {
        throw new Error(`读取提审数据表分页失败：${tableName}`);
      }
    } while (pageToken);
    return undefined;
  }

  private async findRecoverableTable(
    token: string,
    baseAppToken: string,
    tableName: string,
  ): Promise<string | undefined> {
    const tableId = await this.findTableByName(token, baseAppToken, tableName);
    if (!tableId) return undefined;
    const marker = await this.findFieldByName(
      token,
      baseAppToken,
      tableId,
      '审批实例编号',
    );
    return marker?.type === 1 ? tableId : undefined;
  }

  private async findFieldByName(
    token: string,
    baseAppToken: string,
    tableId: string,
    fieldName: string,
  ): Promise<{ fieldId: string; type: number } | undefined> {
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const response = await this.feishu.api<FeishuListFieldResponse>(
        `bitable/v1/apps/${baseAppToken}/tables/${tableId}/fields?${query}`,
        token,
      );
      const match = (response.items || []).find(
        (item) => item.field_id && item.field_name === fieldName && typeof item.type === 'number',
      );
      if (match?.field_id && typeof match.type === 'number') {
        return { fieldId: match.field_id, type: match.type };
      }
      pageToken = response.has_more ? response.page_token : undefined;
      if (response.has_more && !pageToken) {
        throw new Error(`读取提审字段分页失败：${fieldName}`);
      }
    } while (pageToken);
    return undefined;
  }

  private async createSystemFields(
    token: string,
    baseAppToken: string,
    tableId: string,
  ): Promise<TargetWriteBackFieldBindings> {
    const fields: TargetWriteBackFieldBindings = {
      instanceCodeFieldId: '',
      statusFieldId: '',
      submittedAtFieldId: '',
      batchIdFieldId: '',
    };
    for (const definition of TARGET_SYSTEM_FIELD_DEFINITIONS) {
      const fieldId = await this.createField(
        token,
        baseAppToken,
        tableId,
        definition.name,
        {
          apiType: definition.apiType,
          baseFieldType: definition.apiType === 5 ? 'date' : 'text',
        },
      );
      fields[definition.key] = fieldId;
    }
    return fields;
  }
}

export function isTargetProvisioningValidationError(
  error: unknown,
): error is z.ZodError {
  return error instanceof z.ZodError;
}
