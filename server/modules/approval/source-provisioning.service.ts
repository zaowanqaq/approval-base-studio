import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
  ApprovalSchemaSchema,
  createSyncedFieldBinding,
  SourceProvisioningRequestSchema,
  SourceProvisioningResultSchema,
  SourceTableDestinationSchema,
} from '../../../shared/approval';
import type {
  ApprovalControl,
  ApprovalSchema,
  NewBaseSourceTableDestination,
  SourceProvisioningRequest,
  SourceProvisioningResult,
  SourceSystemFieldBindings,
  SourceTableDestination,
} from '../../../shared/approval';
import { ApprovalSchemaService } from './approval-schema.service';
import {
  approvalFieldMapping,
  type ApprovalFieldMapping,
} from './approval-field-mapping';
import { FeishuService } from './feishu.service';

interface FeishuBaseInfo {
  app_token?: string;
  default_table_id?: string;
  url?: string;
}

interface FeishuCreateBaseResponse {
  app?: FeishuBaseInfo;
}

interface FeishuCreateTableResponse {
  table_id?: string;
}

interface FeishuCreateFieldResponse {
  field?: {
    field_id?: string;
  };
}

const SOURCE_SYSTEM_FIELD_DEFINITIONS = [
  { key: 'instanceCodeFieldId', name: '审批实例编号', apiType: 1 },
  { key: 'statusFieldId', name: '审批状态', apiType: 1 },
  { key: 'submittedAtFieldId', name: '审批提交时间', apiType: 5 },
  { key: 'syncedAtFieldId', name: '同步时间', apiType: 5 },
] as const;

@Injectable()
export class SourceProvisioningService {
  constructor(
    private readonly feishu: FeishuService,
    private readonly approvalSchemas: ApprovalSchemaService,
  ) {}

  async provision(
    token: string,
    input: unknown,
  ): Promise<SourceProvisioningResult> {
    const request: SourceProvisioningRequest =
      SourceProvisioningRequestSchema.parse(input) as SourceProvisioningRequest;
    const rawSchema = await this.approvalSchemas.readApprovalSchema(
      token,
      request.approvalCode,
    );
    const schema: ApprovalSchema =
      ApprovalSchemaSchema.parse(rawSchema) as ApprovalSchema;
    return this.provisionSchema(token, schema, request.destination);
  }

  async provisionSchema(
    token: string,
    schema: ApprovalSchema,
    destination: SourceTableDestination,
  ): Promise<SourceProvisioningResult> {
    const validatedSchema: ApprovalSchema =
      ApprovalSchemaSchema.parse(schema) as ApprovalSchema;
    const validatedDestination: SourceTableDestination =
      SourceTableDestinationSchema.parse(destination) as SourceTableDestination;
    this.validateSchema(validatedSchema);
    const names = this.resolveNames(validatedSchema, validatedDestination);
    this.validateSystemFieldNames(validatedSchema);
    const table = await this.createSourceTable(
      token,
      names.baseName,
      names.tableName,
      validatedDestination,
    );
    const tableId = table.tableId;

    const syncedFieldBindings: SourceProvisioningResult['syncedFieldBindings'] = [];
    for (const control of validatedSchema.controls) {
      const field = await this.createField(
        token,
        table.appToken,
        tableId,
        control,
      );
      syncedFieldBindings.push(
        createSyncedFieldBinding({
          sourceApprovalCode: validatedSchema.approvalCode,
          sourceControlId: control.id,
          sourceControlName: control.name.trim(),
          sourceControlType: control.type,
          baseTableId: tableId,
          baseFieldId: field.fieldId,
          baseFieldName: control.name.trim(),
          baseFieldType: field.mapping.baseFieldType,
        }),
      );
    }

    const systemFields = await this.createSystemFields(
      token,
      table.appToken,
      tableId,
    );

    const result: SourceProvisioningResult = {
      sourceTableBinding: {
        sourceApprovalCode: validatedSchema.approvalCode,
        baseAppToken: table.appToken,
        baseTableId: tableId,
        baseTableName: names.tableName,
        systemFields,
        ...(table.url ? { baseUrl: table.url } : {}),
      },
      syncedFieldBindings,
      connectorPlan: {
        sourceApprovalCode: validatedSchema.approvalCode,
        baseTableId: tableId,
        status: 'api-sync-enabled',
        mode: 'api',
        mapping: 'source-control-id-to-base-field-id',
        bindings: syncedFieldBindings.map((binding) => ({
          sourceControlId: binding.sourceControlId,
          baseFieldId: binding.baseFieldId,
        })),
        systemFields,
      },
    };
    return SourceProvisioningResultSchema.parse(result) as SourceProvisioningResult;
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

  private validateSystemFieldNames(schema: ApprovalSchema): void {
    const controlNames = new Set(
      schema.controls.map((control: ApprovalControl) =>
        control.name.trim().replace(/\s+/gu, '').toLowerCase(),
      ),
    );
    for (const definition of SOURCE_SYSTEM_FIELD_DEFINITIONS) {
      const nameKey = definition.name.replace(/\s+/gu, '').toLowerCase();
      if (controlNames.has(nameKey)) {
        throw new BadRequestException(
          `审批控件名称“${definition.name}”与同步系统字段冲突，请先修改审批控件名称`,
        );
      }
    }
  }

  private resolveNames(
    schema: ApprovalSchema,
    destination: SourceTableDestination,
  ): { baseName: string; tableName: string } {
    const baseName =
      destination.kind === 'new-base'
        ? destination.baseName?.trim() || schema.approvalName.trim()
        : schema.approvalName.trim();
    const tableName = destination.tableName?.trim() || schema.approvalName.trim();
    this.validateResourceName('Base', baseName);
    this.validateResourceName('数据表', tableName);
    return { baseName, tableName };
  }

  private validateResourceName(kind: string, name: string): void {
    if (!name || name.length > 100 || /[\\/?*:[\]]/u.test(name)) {
      throw new BadRequestException(
        `${kind}名称不能为空、不能超过 100 个字符且不能包含 / \\ ? * : [ ]`,
      );
    }
  }

  private async createBase(
    token: string,
    baseName: string,
    destination: NewBaseSourceTableDestination,
  ): Promise<{ appToken: string; defaultTableId: string; url?: string }> {
    const response = await this.feishu.api<FeishuCreateBaseResponse>(
      'bitable/v1/apps',
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          name: baseName,
          time_zone: 'Asia/Shanghai',
          ...(destination.folderToken
            ? { folder_token: destination.folderToken }
            : {}),
        }),
      },
    );
    const appToken = response.app?.app_token;
    const defaultTableId = response.app?.default_table_id;
    if (!appToken || !defaultTableId) {
      throw new Error('飞书创建多维表格成功但未返回表格或默认数据表标识');
    }
    return {
      appToken,
      defaultTableId,
      ...(response.app?.url ? { url: response.app.url } : {}),
    };
  }

  private async createSourceTable(
    token: string,
    baseName: string,
    tableName: string,
    destination: SourceTableDestination,
  ): Promise<{ appToken: string; tableId: string; url?: string }> {
    if (destination.kind === 'new-base') {
      const base = await this.createBase(token, baseName, destination);
      await this.renameTable(
        token,
        base.appToken,
        base.defaultTableId,
        tableName,
      );
      return {
        appToken: base.appToken,
        tableId: base.defaultTableId,
        ...(base.url ? { url: base.url } : {}),
      };
    }

    const response = await this.feishu.api<FeishuCreateTableResponse>(
      `bitable/v1/apps/${destination.baseAppToken}/tables`,
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
      throw new Error('飞书创建数据表成功但未返回数据表标识');
    }
    return {
      appToken: destination.baseAppToken,
      tableId: response.table_id,
    };
  }

  private async renameTable(
    token: string,
    appToken: string,
    tableId: string,
    tableName: string,
  ): Promise<void> {
    await this.feishu.api(
      `bitable/v1/apps/${appToken}/tables/${tableId}`,
      token,
      {
        method: 'PATCH',
        body: JSON.stringify({ name: tableName }),
      },
    );
  }

  private async createField(
    token: string,
    appToken: string,
    tableId: string,
    control: ApprovalControl,
  ): Promise<{ fieldId: string; mapping: ApprovalFieldMapping }> {
    const mapping = this.mappingFor(control);
    const fieldId = await this.createBaseField(
      token,
      appToken,
      tableId,
      control.name.trim(),
      mapping,
    );
    return { fieldId, mapping };
  }

  private async createSystemFields(
    token: string,
    appToken: string,
    tableId: string,
  ): Promise<SourceSystemFieldBindings> {
    const fields: SourceSystemFieldBindings = {
      instanceCodeFieldId: '',
      statusFieldId: '',
      submittedAtFieldId: '',
      syncedAtFieldId: '',
    };
    for (const definition of SOURCE_SYSTEM_FIELD_DEFINITIONS) {
      const fieldId = await this.createBaseField(
        token,
        appToken,
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

  private async createBaseField(
    token: string,
    appToken: string,
    tableId: string,
    fieldName: string,
    mapping: ApprovalFieldMapping,
  ): Promise<string> {
    const response = await this.feishu.api<FeishuCreateFieldResponse>(
      `bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          field_name: fieldName,
          type: mapping.apiType,
        }),
      },
    );
    const fieldId = response.field?.field_id;
    if (!fieldId) {
      throw new Error(`飞书创建字段“${fieldName}”成功但未返回字段标识`);
    }
    return fieldId;
  }
}

export function isSourceProvisioningValidationError(
  error: unknown,
): error is z.ZodError {
  return error instanceof z.ZodError;
}
