import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  ApprovalSchemaSchema,
  TargetLaunchRequestSchema,
  TargetLaunchResponseSchema,
} from '../../../shared/approval';
import { isComputedApprovalControl } from '../../../shared/approval';
import type {
  ApprovalControl,
  ApprovalSchema,
  BasePluginTargetConfiguration,
  TargetFieldAtomicSource,
  TargetFieldBinding,
  TargetFieldSource,
  TargetLaunchRecordResult,
  TargetLaunchRequest,
  TargetLaunchResponse,
} from '../../../shared/approval';
import {
  ApprovalSchemaService,
  approvalSchemaFingerprint,
} from './approval-schema.service';
import { ApprovalSubmissionService } from './approval-submission.service';
import {
  BitableFieldMeta,
  BitableRecord,
  BitableRecordService,
} from './bitable-record.service';
import { baseReferenceFromUrl, extractBaseToken } from './base-reference';
import { BasePluginProfileService } from './base-plugin-profile.service';
import { FeishuService } from './feishu.service';
import { TargetLaunchStateService } from './target-launch-state.service';
import type { TargetLaunchStateRow } from './target-launch-state.service';
import { evaluateDecimalOperation } from './controlled-decimal';

type UploadedTargetFile = {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

type LaunchSource = TargetFieldSource;

type AttachmentInput = {
  name: string;
  contentType?: string;
  buffer?: Buffer;
  fileToken?: string;
  uploadType: 'attachment' | 'image';
};

type PreparedControl = {
  control: ApprovalControl;
  value: unknown;
  attachments?: AttachmentInput[];
};

type PreparedRecord = {
  record: BitableRecord;
  controls: PreparedControl[];
};

@Injectable()
export class TargetLaunchService {
  constructor(
    private readonly feishu: FeishuService,
    private readonly approvalSchemas: ApprovalSchemaService,
    private readonly profiles: BasePluginProfileService,
    private readonly bitable: BitableRecordService,
    private readonly approvalSubmission: ApprovalSubmissionService,
    private readonly launchState: TargetLaunchStateService,
  ) {}

  async launch(
    token: string,
    tenantId: string,
    userId: string,
    input: unknown,
    files: UploadedTargetFile[] = [],
  ): Promise<TargetLaunchResponse> {
    const request = TargetLaunchRequestSchema.parse(input) as TargetLaunchRequest;
    const baseRef = baseReferenceFromUrl(request.baseUrl);
    const baseToken = extractBaseToken(request.baseUrl);
    const profile = await this.profiles.get(tenantId, request.baseUrl);
    const target = this.targetConfiguration(profile?.config.targetApprovals || [], request.approvalCode);
    const schema = ApprovalSchemaSchema.parse(
      await this.approvalSchemas.readApprovalSchema(token, request.approvalCode),
    ) as ApprovalSchema;
    await this.ensureLaunchable(token, schema);
    this.validateTargetConfiguration(target, schema);

    const batchId = this.newBatchId();
    const claim = await this.launchState.claim({
      tenantId,
      userId,
      baseRef,
      approvalCode: request.approvalCode,
      baseTableId: target.targetTableBinding.baseTableId,
      batchId,
      idempotencyKey: request.idempotencyKey,
      recordIds: request.recordIds,
    });
    if (!claim.created) {
      this.ensureSameRequest(claim.row.recordIds, request.recordIds);
      if (claim.row.status === 'writeback-pending') {
        return this.retryPendingWriteback(token, baseToken, target, claim.row, request.recordIds);
      }
      if (['submitted', 'completed', 'submit-failed', 'partial-failure', 'submit-unknown'].includes(claim.row.status)) {
        return this.responseFromRow(claim.row, '该幂等请求已经处理过，未重复创建审批。');
      }
    }

    await this.launchState.update(claim.row.id, {
      status: 'preflight-failed',
      results: [],
      lastError: null,
    });
    let fields: BitableFieldMeta[];
    let prepared: PreparedRecord[];
    try {
      fields = await this.bitable.listFields(
        token,
        baseToken,
        target.targetTableBinding.baseTableId,
      );
      const records = await this.bitable.readRecords(
        token,
        baseToken,
        target.targetTableBinding.baseTableId,
        request.recordIds,
      );
      prepared = await this.prepareRecords(
        token,
        schema,
        target,
        fields,
        records,
        request.manualInputs || {},
        files,
      );
    } catch (error) {
      await this.launchState.update(claim.row.id, {
        status: 'preflight-failed',
        results: [],
        lastError: this.errorMessage(error),
      });
      throw error;
    }

    const results: TargetLaunchRecordResult[] = [];
    let submittedCount = 0;
    let writebackPending = false;
    for (const [index, preparedRecord] of prepared.entries()) {
      const recordUuid = this.recordUuid(claim.row.batchId, preparedRecord.record.recordId, index);
      let form: Array<Record<string, unknown>>;
      try {
        form = await this.materializeForm(token, preparedRecord.controls);
      } catch (error) {
        const result: TargetLaunchRecordResult = {
          recordId: preparedRecord.record.recordId,
          writebackComplete: false,
          error: this.errorMessage(error),
        };
        results.push(result);
        await this.launchState.update(claim.row.id, {
          status: submittedCount ? 'submit-unknown' : 'upload-failed',
          results,
          lastError: result.error,
        });
        throw new BadGatewayException(
          `审批附件处理失败，批次 ${claim.row.batchId} 已保存：${result.error}`,
        );
      }
      await this.launchState.update(claim.row.id, {
        status: 'submit-unknown',
        results,
        lastError: null,
      });
      let created: { instance_code: string; instance_link?: string };
      try {
        created = await this.approvalSubmission.initiate(
          token,
          request.approvalCode,
          form,
          recordUuid,
        );
      } catch (error) {
        const result: TargetLaunchRecordResult = {
          recordId: preparedRecord.record.recordId,
          writebackComplete: false,
          error: this.errorMessage(error),
        };
        results.push(result);
        await this.launchState.update(claim.row.id, {
          status: 'submit-unknown',
          results,
          lastError: result.error,
        });
        throw new BadGatewayException(
          `审批提交失败，批次 ${claim.row.batchId} 已保存，未重复创建：${result.error}`,
        );
      }

      submittedCount += 1;
      const submittedAt = new Date().toISOString();
      const result: TargetLaunchRecordResult = {
        recordId: preparedRecord.record.recordId,
        instanceCode: created.instance_code,
        approvalStatus: 'PENDING',
        submittedAt,
        writebackComplete: false,
      };
      try {
        await this.bitable.writeBack(
          token,
          baseToken,
          target.targetTableBinding,
          target.targetTableBinding.writeBackFields,
          fields,
          preparedRecord.record.recordId,
          {
            instanceCode: created.instance_code,
            approvalStatus: 'PENDING',
            submittedAt,
            batchId: claim.row.batchId,
          },
        );
        result.writebackComplete = true;
      } catch (error) {
        result.error = this.errorMessage(error);
        writebackPending = true;
      }
      results.push(result);
      await this.launchState.update(claim.row.id, {
        status: result.writebackComplete ? 'submitted' : 'writeback-pending',
        results,
        lastError: result.error || null,
      });
    }

    const response: TargetLaunchResponse = {
      batchId: claim.row.batchId,
      idempotencyKey: request.idempotencyKey,
      status: writebackPending ? 'writeback-pending' : 'completed',
      submitted: submittedCount > 0,
      writebackComplete: !writebackPending && results.every((item) => item.writebackComplete),
      results,
      ...(writebackPending
        ? { message: `审批已创建，但部分记录回写失败，请保留批次 ${claim.row.batchId} 进行恢复。` }
        : {}),
    };
    await this.launchState.update(claim.row.id, {
      status: response.status,
      results,
      lastError: writebackPending ? response.message : null,
    });
    return TargetLaunchResponseSchema.parse(response) as TargetLaunchResponse;
  }

  private async prepareRecords(
    token: string,
    schema: ApprovalSchema,
    target: BasePluginTargetConfiguration,
    fields: BitableFieldMeta[],
    records: BitableRecord[],
    manualInputs: Record<string, unknown>,
    files: UploadedTargetFile[],
  ): Promise<PreparedRecord[]> {
    const bindingMap = new Map<string, TargetFieldBinding>(
      target.targetFieldBindings.map((binding) => [binding.targetControlId, binding]),
    );
    const fieldMap = new Map<string, BitableFieldMeta>(fields.map((field) => [field.fieldId, field]));
    const currentOperator = this.needsCurrentOperator(schema, bindingMap)
      ? await this.currentOperator(token)
      : undefined;
    const currentTime = new Date();
    const prepared: PreparedRecord[] = [];
    for (const record of records) {
      const instanceField = this.bitable.resolveField(
        fields,
        target.targetTableBinding.writeBackFields.instanceCodeFieldId,
        '提审审批实例编号回写',
      );
      const existingInstance = record.fields[instanceField.fieldName];
      if (!this.empty(existingInstance)) {
        throw new BadRequestException(
          `记录 ${record.recordId} 已存在审批实例 ${this.text(existingInstance)}，为避免重复提审，本次已阻断。`,
        );
      }
      const controls: PreparedControl[] = [];
      for (const control of schema.controls) {
        if (isComputedApprovalControl(control)) continue;
        const binding = bindingMap.get(control.id);
        if (!binding) {
          throw new BadRequestException(
            `审批控件 ${control.id}（${control.name}）没有字段绑定，无法提审。`,
          );
        }
        const source = this.sourceFor(binding);
        const sourceField = source.kind === 'base-field'
          ? this.resolveSourceField(
            source,
            fieldMap,
            control,
            target.targetTableBinding.baseTableId,
          )
          : undefined;
        const rawValue = await this.rawValue(
          token,
          source,
          fieldMap,
          record,
          manualInputs,
          files,
          currentOperator,
          currentTime,
          control,
          target.targetTableBinding.baseTableId,
        );
        controls.push(await this.validateValue(control, source, rawValue));
      }
      prepared.push({ record, controls });
    }
    return prepared;
  }

  private async rawValue(
    token: string,
    source: LaunchSource,
    fieldMap: Map<string, BitableFieldMeta>,
    record: BitableRecord,
    manualInputs: Record<string, unknown>,
    files: UploadedTargetFile[],
    currentOperator: string | undefined,
    currentTime: Date,
    control: ApprovalControl,
    targetTableId: string,
  ): Promise<unknown> {
    if (source.kind === 'attachment-merge') {
      if (!['attachmentV2', 'image'].includes(this.formType(control))) {
        throw new BadRequestException(this.controlError(control, '附件合并来源仅支持附件或图片控件'));
      }
      const attachments: AttachmentInput[] = [];
      for (const attachmentSource of source.sources) {
        const value = await this.rawAtomicValue(
          token,
          attachmentSource,
          fieldMap,
          record,
          manualInputs,
          files,
          currentOperator,
          currentTime,
          control,
          targetTableId,
        );
        attachments.push(...this.asAttachments(value));
      }
      return attachments;
    }
    if (source.kind === 'template') {
      if (!['input', 'textarea'].includes(this.formType(control))) {
        throw new BadRequestException(this.controlError(control, '模板来源仅支持文本控件'));
      }
      const parts: string[] = [];
      for (const part of source.parts) {
        if (part.kind === 'literal') {
          parts.push(part.value);
          continue;
        }
        const value = await this.rawAtomicValue(
          token,
          part.source,
          fieldMap,
          record,
          manualInputs,
          files,
          currentOperator,
          currentTime,
          control,
          targetTableId,
        );
        parts.push(this.text(value));
      }
      return parts.join('');
    }
    if (source.kind === 'calculation') {
      if (!['number', 'amount'].includes(this.formType(control))) {
        throw new BadRequestException(this.controlError(control, '计算来源仅支持数字或金额控件'));
      }
      const values: unknown[] = [];
      for (const operand of source.operands) {
        values.push(await this.rawAtomicValue(
          token,
          operand,
          fieldMap,
          record,
          manualInputs,
          files,
          currentOperator,
          currentTime,
          control,
          targetTableId,
        ));
      }
      return evaluateDecimalOperation(
        source.operation,
        values,
        source.scale,
        source.rounding,
      );
    }
    return this.rawAtomicValue(
      token,
      source,
      fieldMap,
      record,
      manualInputs,
      files,
      currentOperator,
      currentTime,
      control,
      targetTableId,
    );
  }

  private async rawAtomicValue(
    token: string,
    source: TargetFieldAtomicSource,
    fieldMap: Map<string, BitableFieldMeta>,
    record: BitableRecord,
    manualInputs: Record<string, unknown>,
    files: UploadedTargetFile[],
    currentOperator: string | undefined,
    currentTime: Date,
    control: ApprovalControl,
    targetTableId: string,
  ): Promise<unknown> {
    if (source.kind === 'base-field') {
      const sourceField = this.resolveSourceField(source, fieldMap, control, targetTableId);
      const value = this.bitable.fieldValue(record, sourceField, control.id);
      if (sourceField.type === 17) {
        return this.bitable.attachmentEntries(value).map((item) => ({
          fileToken: item.fileToken,
          name: item.name,
          uploadType: control.type.toLowerCase().includes('image') ? 'image' : 'attachment',
        } satisfies AttachmentInput));
      }
      return value;
    }
    if (source.kind === 'manual') {
      if (source.inputType === 'attachment') {
        return files
          .filter((file) => file.fieldname === `manualInput:${source.inputKey}`)
          .map((file) => ({
            name: file.originalname,
            contentType: file.mimetype,
            buffer: file.buffer,
            uploadType: control.type.toLowerCase().includes('image') ? 'image' : 'attachment',
          } satisfies AttachmentInput));
      }
      return manualInputs[source.inputKey];
    }
    if (source.kind === 'fixed-value') return source.value;
    if (source.kind === 'current-operator') {
      if (!currentOperator) throw new BadRequestException(this.controlError(control, '无法识别当前操作人'));
      return currentOperator;
    }
    return currentTime;
  }

  private async validateValue(
    control: ApprovalControl,
    source: LaunchSource,
    rawValue: unknown,
  ): Promise<PreparedControl> {
    const formType = this.formType(control);
    const context = `审批控件 ${control.id}（${control.name}）`;
    if (formType === 'attachmentV2' || formType === 'image') {
      const attachments = this.asAttachments(rawValue);
      if (control.required && attachments.length === 0) {
        throw new BadRequestException(`${context}为必填项，但附件来源没有值`);
      }
      if (
        source.kind !== 'base-field' &&
        source.kind !== 'manual' &&
        source.kind !== 'attachment-merge' &&
        attachments.length > 0
      ) {
        throw new BadRequestException(`${context}的附件来源配置无效`);
      }
      return { control, value: attachments.map(() => null), attachments };
    }
    if (formType === 'contact') {
      if (source.kind === 'current-time' || source.kind === 'manual' && source.inputType !== 'text') {
        throw new BadRequestException(`${context}只能使用人员字段或当前操作人来源`);
      }
      const ids = this.userIds(rawValue);
      if (source.kind === 'current-operator' && ids.length === 0) {
        throw new BadRequestException(`${context}无法解析当前操作人`);
      }
      if (control.required && ids.length === 0) throw new BadRequestException(`${context}为必填项，但没有人员值`);
      return { control, value: ids };
    }
    if (formType === 'department') {
      if (source.kind === 'current-time' || source.kind === 'current-operator') {
        throw new BadRequestException(`${context}不能使用当前时间或当前操作人来源`);
      }
      const departmentIds = this.departmentIds(rawValue);
      if (control.required && departmentIds.length === 0) {
        throw new BadRequestException(`${context}为必填项，但没有部门值`);
      }
      return {
        control,
        value: departmentIds.map((id: string) => ({ open_id: id })),
      };
    }
    if (formType === 'radioV2') {
      const value = this.text(rawValue);
      const options = this.radioOptionValues(control);
      if (value && options.length > 0 && !options.includes(value)) {
        throw new BadRequestException(`${context}的选项值不在最新 Schema 中`);
      }
      if (control.required && this.empty(value)) {
        throw new BadRequestException(`${context}为必填项，但没有有效选项`);
      }
      return { control, value };
    }
    if (source.kind === 'current-operator') {
      throw new BadRequestException(`${context}不是人员控件，不能使用当前操作人来源`);
    }
    if (source.kind === 'current-time' && formType !== 'date') {
      throw new BadRequestException(`${context}不是日期控件，不能使用当前时间来源`);
    }
    let value: unknown = rawValue;
    if (formType === 'number' || formType === 'amount') value = this.decimal(rawValue, context);
    else if (formType === 'date') value = this.approvalDate(rawValue, context);
    else if (formType === 'checkbox') {
      value = this.checkboxValues(rawValue);
      if (control.required && Array.isArray(value) && value.length === 0) {
        throw new BadRequestException(`${context}为必填项，但没有有效选项`);
      }
    } else {
      value = this.text(rawValue);
    }
    if (control.required && this.empty(value)) throw new BadRequestException(`${context}为必填项，但来源没有值`);
    if (!control.required && this.empty(value)) value = '';
    return { control, value };
  }

  private async materializeForm(token: string, controls: PreparedControl[]): Promise<Array<Record<string, unknown>>> {
    const form: Array<Record<string, unknown>> = [];
    for (const item of controls) {
      if (item.attachments) {
        const codes: string[] = [];
        for (const attachment of item.attachments) {
          let buffer = attachment.buffer;
          let contentType = attachment.contentType || 'application/octet-stream';
          if (!buffer && attachment.fileToken) {
            const downloaded = await this.feishu.download(
              `drive/v1/medias/${attachment.fileToken}/download`,
              token,
            );
            buffer = downloaded.buffer;
            contentType = downloaded.contentType;
          }
          if (!buffer) throw new Error(`附件 ${attachment.name} 缺少可上传内容`);
          codes.push(await this.approvalSubmission.uploadFile(
            buffer,
            attachment.name,
            contentType,
            attachment.uploadType,
          ));
        }
        if (codes.length || item.control.required) {
          form.push({ id: item.control.id, type: this.formType(item.control), value: codes });
        }
        continue;
      }
      const normalizedType = item.control.type.toLowerCase().replace(/[-_]/gu, '');
      const value = normalizedType === 'contact' || normalizedType === 'user'
        ? { id: item.control.id, type: 'contact', open_ids: item.value }
        : normalizedType === 'department'
          ? { id: item.control.id, type: 'department', value: item.value }
        : {
          id: item.control.id,
          type: this.formType(item.control),
          value: item.value,
          ...(this.formType(item.control) === 'amount' ? { currency: 'CNY' } : {}),
        };
      if (item.control.required || !this.empty(item.value)) form.push(value);
    }
    return form;
  }

  private targetConfiguration(
    targets: BasePluginTargetConfiguration[],
    approvalCode: string,
  ): BasePluginTargetConfiguration {
    const target = targets.find(
      (item) => item.targetTableBinding.targetApprovalCode === approvalCode,
    );
    if (!target) throw new BadRequestException(`当前 Base 尚未配置目标审批流 ${approvalCode}`);
    return target;
  }

  private async ensureLaunchable(token: string, schema: ApprovalSchema): Promise<void> {
    const result = await this.approvalSchemas.searchLaunchableApprovals(
      token,
      schema.approvalName,
      undefined,
      100,
    );
    const match = result.items.find((item) => item.approvalCode === schema.approvalCode);
    if (!match) {
      throw new BadRequestException(
        `审批流 ${schema.approvalCode} 当前不存在或当前操作人不可发起`,
      );
    }
    if (match.isExternal) {
      throw new BadRequestException(
        `审批流 ${schema.approvalCode} 是三方审批，不能通过原生审批接口发起`,
      );
    }
  }

  private validateTargetConfiguration(
    target: BasePluginTargetConfiguration,
    schema: ApprovalSchema,
  ): void {
    if (schema.approvalCode !== target.targetTableBinding.targetApprovalCode) {
      throw new BadRequestException('目标审批 Schema 与已保存配置不一致');
    }
    const currentFingerprint = approvalSchemaFingerprint(schema);
    if (!target.approvalSchemaFingerprint) {
      throw new BadRequestException(
        '目标审批配置没有保存审批结构快照，请重新读取并保存该审批流配置后再提审',
      );
    }
    if (target.approvalSchemaFingerprint !== currentFingerprint) {
      throw new BadRequestException(
        '目标审批结构已发生变化（可能新增、删除、改名或修改类型/必填性），请重新读取并保存配置',
      );
    }
    for (const control of schema.controls) {
      if (control.children?.length) {
        throw new BadRequestException(
          `审批控件 ${control.id}（${control.name}）包含明细控件，本轮不支持复杂嵌套结构`,
        );
      }
      if (isComputedApprovalControl(control)) continue;
      this.formType(control);
    }
    if (schema.nodes.some((node) => node.requiresApproverSelection === true)) {
      throw new BadRequestException(
        '当前审批流包含发起人自选审批节点，通用提审暂未配置节点审批人',
      );
    }
    const bindingIds = new Set<string>();
    for (const binding of target.targetFieldBindings) {
      if (bindingIds.has(binding.targetControlId)) {
        throw new BadRequestException(
          `审批控件 ${binding.targetControlId} 存在重复字段绑定`,
        );
      }
      bindingIds.add(binding.targetControlId);
      if (!schema.controls.some((control) => control.id === binding.targetControlId)) {
        throw new BadRequestException(`已保存字段绑定引用了不存在的审批控件 ${binding.targetControlId}`);
      }
    }
    for (const control of schema.controls) {
      if (isComputedApprovalControl(control)) continue;
      if (!bindingIds.has(control.id)) {
        throw new BadRequestException(
          `审批控件 ${control.id}（${control.name}）缺少字段绑定`,
        );
      }
    }
  }

  private resolveSourceField(
    source: Extract<LaunchSource, { kind: 'base-field' }>,
    fieldMap: Map<string, BitableFieldMeta>,
    control: ApprovalControl,
    targetTableId: string,
  ): BitableFieldMeta {
    if (source.baseTableId !== targetTableId) {
      throw new BadRequestException(this.controlError(control, '暂不支持跨数据表字段来源'));
    }
    const field = fieldMap.get(source.baseFieldId);
    if (!field) throw new BadRequestException(this.controlError(control, `来源字段 ${source.baseFieldId} 不存在`));
    const key = control.type.trim().toLowerCase().replace(/[-_]/gu, '');
    const allowed = key === 'amount' || key === 'number'
      ? [2]
      : ['date', 'datetime'].includes(key)
        ? [5]
        : ['attachment', 'attachmentv2', 'image', 'imagev2'].includes(key)
          ? [17]
      : ['contact', 'user'].includes(key)
            ? [11]
            : ['radio', 'radiov2'].includes(key)
              ? [3]
              : key === 'department'
                ? [1, 11]
            : key === 'checkbox'
              ? [7]
              : [1, 13, 15];
    if (!allowed.includes(field.type)) {
      throw new BadRequestException(
        this.controlError(control, `来源字段 ${field.fieldId} 类型 ${field.type} 与审批控件不兼容`),
      );
    }
    return field;
  }

  private sourceFor(binding: TargetFieldBinding): LaunchSource {
    const source = binding.source as TargetFieldSource | undefined;
    if (!source) {
      return {
        kind: 'base-field',
        baseTableId: binding.baseTableId,
        baseFieldId: binding.baseFieldId,
      };
    }
    return source as LaunchSource;
  }

  private formType(control: ApprovalControl): 'input' | 'textarea' | 'number' | 'amount' | 'date' | 'attachmentV2' | 'image' | 'contact' | 'department' | 'radioV2' | 'checkbox' {
    const key = control.type.trim().toLowerCase().replace(/[-_]/gu, '');
    if (['text', 'input', 'phone', 'url'].includes(key)) return 'input';
    if (key === 'textarea') return 'textarea';
    if (key === 'number') return 'number';
    if (key === 'amount') return 'amount';
    if (['date', 'datetime'].includes(key)) return 'date';
    if (['attachment', 'attachmentv2'].includes(key)) return 'attachmentV2';
    if (['image', 'imagev2'].includes(key)) return 'image';
    if (['contact', 'user'].includes(key)) return 'contact';
    if (key === 'department') return 'department';
    if (['radio', 'radiov2'].includes(key)) return 'radioV2';
    if (['checkbox', 'checkboxv2'].includes(key)) return 'checkbox';
    throw new BadRequestException(
      `审批控件 ${control.id}（${control.name}）类型 ${control.type} 暂不支持通用发起`,
    );
  }

  private needsCurrentOperator(
    schema: ApprovalSchema,
    bindings: Map<string, TargetFieldBinding>,
  ): boolean {
    return schema.controls.some((control) => this.sourceNeedsCurrentOperator(this.sourceFor(bindings.get(control.id) || {
      targetApprovalCode: schema.approvalCode,
      targetControlId: control.id,
      targetControlName: control.name,
      targetControlType: control.type,
      baseTableId: '',
      baseFieldId: '',
      baseFieldName: '',
      baseFieldType: '',
    })));
  }

  private sourceNeedsCurrentOperator(source: LaunchSource): boolean {
    if (source.kind === 'current-operator') return true;
    if (source.kind === 'template') {
      return source.parts.some((part) =>
        part.kind === 'source' && this.sourceNeedsCurrentOperator(part.source));
    }
    if (source.kind === 'calculation') {
      return source.operands.some((operand) => this.sourceNeedsCurrentOperator(operand));
    }
    if (source.kind === 'attachment-merge') {
      return source.sources.some((operand) => this.sourceNeedsCurrentOperator(operand));
    }
    return false;
  }

  private async currentOperator(token: string): Promise<string> {
    const user = await this.feishu.api<{ open_id?: string }>('authen/v1/user_info', token);
    if (!user.open_id) throw new BadRequestException('无法获取当前操作人的飞书 open_id');
    return user.open_id;
  }

  private asAttachments(value: unknown): AttachmentInput[] {
    if (Array.isArray(value) && value.every((item) => item && typeof item === 'object' && ('buffer' in item || 'fileToken' in item))) return value as AttachmentInput[];
    return [];
  }

  private userIds(value: unknown): string[] {
    const items = Array.isArray(value) ? value : [value];
    return items.flatMap((item) => {
      if (typeof item === 'string' && item.trim()) return [item.trim()];
      if (item && typeof item === 'object' && 'id' in item) {
        const id = String((item as { id?: unknown }).id || '').trim();
        return id ? [id] : [];
      }
      return [];
    });
  }

  private departmentIds(value: unknown): string[] {
    const items = Array.isArray(value) ? value : [value];
    return items.flatMap((item: unknown) => {
      if (typeof item === 'string' && item.trim()) return [item.trim()];
      if (!item || typeof item !== 'object') return [];
      const object = item as Record<string, unknown>;
      const id = String(object.open_id || object.open_department_id || object.id || '').trim();
      return id ? [id] : [];
    });
  }

  private radioOptionValues(control: ApprovalControl): string[] {
    if (!control.raw || typeof control.raw !== 'object') return [];
    const raw = control.raw as Record<string, unknown>;
    const option = raw.option;
    if (!Array.isArray(option)) return [];
    return option.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const value = String((item as Record<string, unknown>).value || '').trim();
      return value ? [value] : [];
    });
  }

  private checkboxValues(value: unknown): string[] {
    const items = Array.isArray(value) ? value : [value];
    return items.flatMap((item: unknown) => {
      if (typeof item === 'string' && item.trim()) return [item.trim()];
      if (!item || typeof item !== 'object') return [];
      const object = item as Record<string, unknown>;
      const option = String(object.value || object.key || object.id || '').trim();
      return option ? [option] : [];
    });
  }

  private decimal(value: unknown, context: string): string {
    const text = this.text(value);
    if (!text || !/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/u.test(text)) {
      throw new BadRequestException(`${context}需要有效的十进制数字`);
    }
    return text;
  }

  private approvalDate(value: unknown, context: string): string {
    const date = value instanceof Date ? value : new Date(value as string | number);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${context}需要有效的日期/时间`);
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(date);
    return `${parts.replace(' ', 'T')}+08:00`;
  }

  private empty(value: unknown): boolean {
    return value == null || value === '' || (Array.isArray(value) && value.length === 0);
  }

  private text(value: unknown): string {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map((item) => this.text(item)).filter(Boolean).join(',');
    if (typeof value === 'object' && value && 'text' in value) return String((value as { text?: unknown }).text || '');
    return String(value).trim();
  }

  private controlError(control: ApprovalControl, message: string): string {
    return `审批控件 ${control.id}（${control.name}）${message}`;
  }

  private ensureSameRequest(storedRecordIds: unknown, recordIds: string[]): void {
    const stored = Array.isArray(storedRecordIds) ? storedRecordIds.map(String).sort() : [];
    const current = [...recordIds].sort();
    if (JSON.stringify(stored) !== JSON.stringify(current)) {
      throw new BadRequestException('幂等键已用于另一组记录，拒绝复用以避免重复审批');
    }
  }

  private responseFromRow(row: { batchId: string; idempotencyKey: string; status: string; results: unknown }, message: string): TargetLaunchResponse {
    const results = Array.isArray(row.results) ? row.results : [];
    return TargetLaunchResponseSchema.parse({
      batchId: row.batchId,
      idempotencyKey: row.idempotencyKey,
      status: row.status,
      submitted: results.some((item) => item && typeof item === 'object' && 'instanceCode' in item),
      writebackComplete: row.status === 'completed',
      results,
      message,
    }) as TargetLaunchResponse;
  }

  private async retryPendingWriteback(
    token: string,
    baseToken: string,
    target: BasePluginTargetConfiguration,
    row: TargetLaunchStateRow,
    recordIds: string[],
  ): Promise<TargetLaunchResponse> {
    const fields = await this.bitable.listFields(
      token,
      baseToken,
      target.targetTableBinding.baseTableId,
    );
    const records = await this.bitable.readRecords(
      token,
      baseToken,
      target.targetTableBinding.baseTableId,
      recordIds,
    );
    const recordSet = new Set(records.map((record: BitableRecord) => record.recordId));
    const results = this.launchState.parseResults(row).map((item) => ({ ...item }));
    for (const result of results) {
      if (result.writebackComplete || !result.instanceCode || !result.submittedAt) continue;
      if (!recordSet.has(result.recordId)) {
        result.error = `记录 ${result.recordId} 当前不可访问，无法恢复回写`;
        continue;
      }
      try {
        await this.bitable.writeBack(
          token,
          baseToken,
          target.targetTableBinding,
          target.targetTableBinding.writeBackFields,
          fields,
          result.recordId,
          {
            instanceCode: result.instanceCode,
            approvalStatus: result.approvalStatus || 'PENDING',
            submittedAt: result.submittedAt,
            batchId: row.batchId,
          },
        );
        result.writebackComplete = true;
        delete result.error;
      } catch (error) {
        result.error = this.errorMessage(error);
      }
    }
    const completed = results.every((item) => item.writebackComplete);
    const message = completed
      ? '已恢复完成上一次审批的回写。'
      : `审批已创建，但回写仍未全部完成，请保留批次 ${row.batchId}。`;
    const status = completed ? 'completed' : 'writeback-pending';
    await this.launchState.update(row.id, {
      status,
      results,
      lastError: completed ? null : message,
    });
    return TargetLaunchResponseSchema.parse({
      batchId: row.batchId,
      idempotencyKey: row.idempotencyKey,
      status,
      submitted: results.some((item) => Boolean(item.instanceCode)),
      writebackComplete: completed,
      results,
      message,
    }) as TargetLaunchResponse;
  }

  private recordUuid(batchId: string, recordId: string, index: number): string {
    return `${batchId}-${index}-${createHash('sha256').update(recordId).digest('hex').slice(0, 12)}`.slice(0, 64);
  }

  private newBatchId(): string {
    return `TARGET-${Date.now()}-${randomBytes(5).toString('hex')}`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
