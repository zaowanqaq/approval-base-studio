import { TargetLaunchService } from '../../server/modules/approval/target-launch.service';
import type { ApprovalSchemaService } from '../../server/modules/approval/approval-schema.service';
import type { ApprovalSubmissionService } from '../../server/modules/approval/approval-submission.service';
import type { BitableRecordService } from '../../server/modules/approval/bitable-record.service';
import type { BasePluginProfileService } from '../../server/modules/approval/base-plugin-profile.service';
import type { FeishuService } from '../../server/modules/approval/feishu.service';
import type { TargetLaunchStateService } from '../../server/modules/approval/target-launch-state.service';
import type { ApprovalSchema, BasePluginProfileResponse } from '../../shared/approval';
import { approvalSchemaFingerprint } from '../../server/modules/approval/approval-schema.service';

const schema: ApprovalSchema = {
  approvalCode: 'approval-target-test-001',
  approvalName: '脱敏通用测试审批',
  controls: [
    { id: 'control-base-text', name: '记录文本', type: 'input', required: true, visible: true },
    { id: 'control-manual-amount', name: '手动金额', type: 'amount', required: true, visible: true },
    { id: 'control-fixed-text', name: '固定说明', type: 'textarea', required: true, visible: true },
    { id: 'control-attachment', name: '附件', type: 'attachmentV2', required: true, visible: true },
  ],
  nodes: [],
};

function profile(): BasePluginProfileResponse {
  return {
    baseRef: 'redacted-base-ref',
    config: {
      version: 1,
      page: { title: '审批提审', visibleModules: [] },
      businessModules: ['approvals'],
      targetApprovals: [{
        approvalSchemaFingerprint: approvalSchemaFingerprint(schema),
        targetTableBinding: {
          targetApprovalCode: schema.approvalCode,
          baseTableId: 'table-target-test',
          baseTableName: '通用测试提审表',
          writeBackFields: {
            instanceCodeFieldId: 'field-instance',
            statusFieldId: 'field-status',
            submittedAtFieldId: 'field-submitted',
            batchIdFieldId: 'field-batch',
          },
        },
        targetFieldBindings: [
          {
            targetApprovalCode: schema.approvalCode,
            targetControlId: 'control-base-text',
            targetControlName: '记录文本',
            targetControlType: 'input',
            baseTableId: 'table-target-test',
            baseFieldId: 'field-base-text',
            baseFieldName: '记录文本',
            baseFieldType: 'text',
            source: { kind: 'base-field', baseTableId: 'table-target-test', baseFieldId: 'field-base-text' },
          },
          {
            targetApprovalCode: schema.approvalCode,
            targetControlId: 'control-manual-amount',
            targetControlName: '手动金额',
            targetControlType: 'amount',
            baseTableId: 'table-target-test',
            baseFieldId: 'field-manual-amount',
            baseFieldName: '手动金额',
            baseFieldType: 'amount',
            source: { kind: 'manual', inputKey: 'manual-amount', inputType: 'amount' },
          },
          {
            targetApprovalCode: schema.approvalCode,
            targetControlId: 'control-fixed-text',
            targetControlName: '固定说明',
            targetControlType: 'textarea',
            baseTableId: 'table-target-test',
            baseFieldId: 'field-fixed-text',
            baseFieldName: '固定说明',
            baseFieldType: 'text',
            source: { kind: 'fixed-value', value: '固定测试值' },
          },
          {
            targetApprovalCode: schema.approvalCode,
            targetControlId: 'control-attachment',
            targetControlName: '附件',
            targetControlType: 'attachmentV2',
            baseTableId: 'table-target-test',
            baseFieldId: 'field-attachment',
            baseFieldName: '附件',
            baseFieldType: 'attachment',
            source: { kind: 'base-field', baseTableId: 'table-target-test', baseFieldId: 'field-attachment' },
          },
        ],
      }],
    },
  };
}

function fields() {
  return [
    { fieldId: 'field-base-text', fieldName: '记录文本', type: 1 },
    { fieldId: 'field-manual-amount', fieldName: '手动金额', type: 2 },
    { fieldId: 'field-fixed-text', fieldName: '固定说明', type: 1 },
    { fieldId: 'field-attachment', fieldName: '附件', type: 17 },
    { fieldId: 'field-instance', fieldName: '审批实例Code', type: 1 },
    { fieldId: 'field-status', fieldName: '审批状态', type: 1 },
    { fieldId: 'field-submitted', fieldName: '提交时间', type: 5 },
    { fieldId: 'field-batch', fieldName: '批次ID', type: 1 },
  ];
}

describe('TargetLaunchService', () => {
  function createService(overrides: {
    recordFields?: Record<string, unknown>;
    existingStatus?: string;
  } = {}) {
    const api = jest.fn();
    const submission = {
      uploadFile: jest.fn().mockResolvedValue('approval-file-code'),
      initiate: jest.fn().mockResolvedValue({ instance_code: 'instance-test-001' }),
    } as unknown as ApprovalSubmissionService;
    const state = {
      claim: jest.fn().mockResolvedValue({
        created: true,
        row: {
          id: 'launch-row-001',
          batchId: 'TARGET-test-001',
          idempotencyKey: 'idempotency-test-001',
          recordIds: ['record-test-001'],
          status: 'preflight-failed',
          results: [],
        },
      }),
      update: jest.fn().mockResolvedValue({}),
    } as unknown as TargetLaunchStateService;
    const bitable = {
      listFields: jest.fn().mockResolvedValue(fields()),
      readRecords: jest.fn().mockResolvedValue([{
        recordId: 'record-test-001',
        fields: {
          '记录文本': '来自记录的文本',
          '附件': [{ token: 'base-file-token', name: '脱敏附件.txt', size: 4 }],
          '审批状态': overrides.existingStatus,
          ...(overrides.recordFields || {}),
        },
      }]),
      resolveField: jest.fn((items, fieldId) => items.find((item) => item.fieldId === fieldId)),
      fieldValue: jest.fn((record, field) => record.fields[field.fieldName]),
      attachmentEntries: jest.fn().mockReturnValue([{ fileToken: 'base-file-token', name: '脱敏附件.txt', size: 4 }]),
      writeBack: jest.fn().mockResolvedValue(undefined),
    } as unknown as BitableRecordService;
    const service = new TargetLaunchService(
      { api, download: jest.fn().mockResolvedValue({ buffer: Buffer.from('test'), contentType: 'text/plain' }) } as unknown as FeishuService,
      {
        readApprovalSchema: jest.fn().mockResolvedValue(schema),
        searchLaunchableApprovals: jest.fn().mockResolvedValue({
          items: [{ approvalCode: schema.approvalCode, approvalName: schema.approvalName, isExternal: false }],
          hasMore: false,
        }),
      } as unknown as ApprovalSchemaService,
      { get: jest.fn().mockResolvedValue(profile()) } as unknown as BasePluginProfileService,
      bitable,
      submission,
      state,
    );
    return { service, submission, state, bitable };
  }

  it('resolves record, manual, fixed and attachment sources then writes back', async () => {
    const { service, submission, bitable } = createService();
    const result = await service.launch(
      'redacted-user-token',
      'tenant-redacted',
      'user-redacted',
      {
        baseUrl: 'https://example.feishu.cn/base/redacted-base',
        approvalCode: schema.approvalCode,
        recordIds: ['record-test-001'],
        manualInputs: { 'manual-amount': '12.50' },
        idempotencyKey: 'idempotency-test-001',
      },
    );

    expect(result).toMatchObject({ status: 'completed', submitted: true, writebackComplete: true });
    expect(submission.uploadFile).toHaveBeenCalledWith(
      Buffer.from('test'),
      '脱敏附件.txt',
      'text/plain',
      'attachment',
    );
    expect(submission.initiate).toHaveBeenCalledWith(
      'redacted-user-token',
      schema.approvalCode,
      expect.arrayContaining([
        { id: 'control-base-text', type: 'input', value: '来自记录的文本' },
        { id: 'control-manual-amount', type: 'amount', value: '12.50', currency: 'CNY' },
        { id: 'control-fixed-text', type: 'textarea', value: '固定测试值' },
        { id: 'control-attachment', type: 'attachmentV2', value: ['approval-file-code'] },
      ]),
      expect.any(String),
    );
    expect(bitable.writeBack).toHaveBeenCalledWith(
      expect.anything(),
      'redacted-base',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'record-test-001',
      expect.objectContaining({
        instanceCode: 'instance-test-001',
        approvalStatus: 'PENDING',
        batchId: 'TARGET-test-001',
      }),
    );
  });

  it('rejects a missing required value before initiating approval', async () => {
    const { service, submission } = createService({ recordFields: { '记录文本': '' } });
    await expect(service.launch(
      'redacted-user-token',
      'tenant-redacted',
      'user-redacted',
      {
        baseUrl: 'https://example.feishu.cn/base/redacted-base',
        approvalCode: schema.approvalCode,
        recordIds: ['record-test-001'],
        manualInputs: { 'manual-amount': '12.50' },
        idempotencyKey: 'idempotency-test-002',
      },
    )).rejects.toThrow('control-base-text');
    expect(submission.initiate).not.toHaveBeenCalled();
  });

  it('rejects an incompatible bound Base field before initiating approval', async () => {
    const { submission } = createService();
    const profileService = {
      get: jest.fn().mockResolvedValue({
        ...profile(),
        config: {
          ...profile().config,
          targetApprovals: profile().config.targetApprovals.map((target) => ({
            ...target,
            targetFieldBindings: target.targetFieldBindings.map((binding) => binding.targetControlId === 'control-base-text'
              ? { ...binding, source: { kind: 'base-field', baseTableId: 'table-target-test', baseFieldId: 'field-manual-amount' } }
              : binding),
          })),
        },
      } as BasePluginProfileResponse),
    } as unknown as BasePluginProfileService;
    const incompatible = new TargetLaunchService(
      {} as FeishuService,
      {
        readApprovalSchema: jest.fn().mockResolvedValue(schema),
        searchLaunchableApprovals: jest.fn().mockResolvedValue({
          items: [{ approvalCode: schema.approvalCode, approvalName: schema.approvalName, isExternal: false }],
          hasMore: false,
        }),
      } as unknown as ApprovalSchemaService,
      profileService,
      {
        listFields: jest.fn().mockResolvedValue(fields()),
        readRecords: jest.fn().mockResolvedValue([{ recordId: 'record-test-001', fields: {} }]),
        resolveField: jest.fn((items, fieldId) => items.find((item) => item.fieldId === fieldId)),
        fieldValue: jest.fn(),
      } as unknown as BitableRecordService,
      submission,
      { claim: jest.fn().mockResolvedValue({ created: true, row: { id: 'row', batchId: 'batch', idempotencyKey: 'key', recordIds: ['record-test-001'], status: 'preflight-failed', results: [] } }), update: jest.fn() } as unknown as TargetLaunchStateService,
    );
    await expect(incompatible.launch(
      'redacted-user-token',
      'tenant-redacted',
      'user-redacted',
      {
        baseUrl: 'https://example.feishu.cn/base/redacted-base',
        approvalCode: schema.approvalCode,
        recordIds: ['record-test-001'],
        manualInputs: { 'manual-amount': '12.50' },
        idempotencyKey: 'idempotency-test-003',
      },
    )).rejects.toThrow('control-base-text');
    expect(submission.initiate).not.toHaveBeenCalled();
  });

  it('rejects an incomplete control binding before reading records', async () => {
    const { service, submission, bitable } = createService();
    const profileService = {
      get: jest.fn().mockResolvedValue({
        ...profile(),
        config: {
          ...profile().config,
          targetApprovals: profile().config.targetApprovals.map((target) => ({
            ...target,
            targetFieldBindings: target.targetFieldBindings.slice(0, -1),
          })),
        },
      } as BasePluginProfileResponse),
    } as unknown as BasePluginProfileService;
    const incomplete = new TargetLaunchService(
      {} as FeishuService,
      {
        readApprovalSchema: jest.fn().mockResolvedValue(schema),
        searchLaunchableApprovals: jest.fn().mockResolvedValue({
          items: [{ approvalCode: schema.approvalCode, approvalName: schema.approvalName, isExternal: false }],
          hasMore: false,
        }),
      } as unknown as ApprovalSchemaService,
      profileService,
      bitable,
      submission,
      {} as TargetLaunchStateService,
    );

    await expect(incomplete.launch('token', 'tenant', 'user', {
      baseUrl: 'https://example.feishu.cn/base/redacted-base',
      approvalCode: schema.approvalCode,
      recordIds: ['record-test-001'],
      idempotencyKey: 'missing-binding',
    })).rejects.toThrow('缺少字段绑定');
    expect(bitable.readRecords).not.toHaveBeenCalled();
    expect(submission.initiate).not.toHaveBeenCalled();
  });

  it('keeps an uncertain submission idempotent and does not retry it', async () => {
    const { service, submission, state } = createService();
    const row = {
      id: 'launch-unknown',
      batchId: 'TARGET-unknown',
      idempotencyKey: 'uncertain-submit',
      recordIds: ['record-test-001'],
      status: 'preflight-failed' as string,
      results: [] as unknown[],
    };
    let created = true;
    (state.claim as unknown as jest.Mock).mockImplementation(async () => {
      const wasCreated = created;
      created = false;
      return { created: wasCreated, row };
    });
    (state.update as unknown as jest.Mock).mockImplementation(async (_id: string, patch: { status: string; results: unknown[] }) => {
      row.status = patch.status;
      row.results = patch.results;
      return row;
    });
    (submission.initiate as unknown as jest.Mock).mockRejectedValue(new Error('网络结果未知'));

    await expect(service.launch('redacted-user-token', 'tenant-redacted', 'user-redacted', {
      baseUrl: 'https://example.feishu.cn/base/redacted-base',
      approvalCode: schema.approvalCode,
      recordIds: ['record-test-001'],
      manualInputs: { 'manual-amount': '12.50' },
      idempotencyKey: 'uncertain-submit',
    })).rejects.toThrow('未重复创建');

    const replay = await service.launch('redacted-user-token', 'tenant-redacted', 'user-redacted', {
      baseUrl: 'https://example.feishu.cn/base/redacted-base',
      approvalCode: schema.approvalCode,
      recordIds: ['record-test-001'],
      manualInputs: { 'manual-amount': '12.50' },
      idempotencyKey: 'uncertain-submit',
    });
    expect(replay.status).toBe('submit-unknown');
    expect(submission.initiate).toHaveBeenCalledTimes(1);
  });

  it('supports text templates and controlled decimal calculations', async () => {
    const { submission, bitable } = createService();
    const configured = profile();
    configured.config.targetApprovals[0].targetFieldBindings =
      configured.config.targetApprovals[0].targetFieldBindings.map((binding) => {
        if (binding.targetControlId === 'control-base-text') {
          return {
            ...binding,
            source: {
              kind: 'template',
              parts: [
                { kind: 'literal', value: '前缀：' },
                {
                  kind: 'source',
                  source: {
                    kind: 'base-field',
                    baseTableId: 'table-target-test',
                    baseFieldId: 'field-base-text',
                  },
                },
              ],
            },
          };
        }
        if (binding.targetControlId === 'control-manual-amount') {
          return {
            ...binding,
            source: {
              kind: 'calculation',
              operation: 'add',
              operands: [
                { kind: 'fixed-value', value: '0.1' },
                { kind: 'fixed-value', value: '0.2' },
              ],
              scale: 2,
              rounding: 'half-up',
            },
          };
        }
        return binding;
      });
    const service = new TargetLaunchService(
      { api: jest.fn(), download: jest.fn().mockResolvedValue({ buffer: Buffer.from('test'), contentType: 'text/plain' }) } as unknown as FeishuService,
      {
        readApprovalSchema: jest.fn().mockResolvedValue(schema),
        searchLaunchableApprovals: jest.fn().mockResolvedValue({
          items: [{ approvalCode: schema.approvalCode, approvalName: schema.approvalName, isExternal: false }],
          hasMore: false,
        }),
      } as unknown as ApprovalSchemaService,
      { get: jest.fn().mockResolvedValue(configured) } as unknown as BasePluginProfileService,
      bitable,
      submission,
      {
        claim: jest.fn().mockResolvedValue({
          created: true,
          row: {
            id: 'row-template',
            batchId: 'batch-template',
            idempotencyKey: 'key-template',
            recordIds: ['record-test-001'],
            status: 'preflight-failed',
            results: [],
          },
        }),
        update: jest.fn().mockResolvedValue({}),
      } as unknown as TargetLaunchStateService,
    );
    await service.launch('redacted-user-token', 'tenant-redacted', 'user-redacted', {
      baseUrl: 'https://example.feishu.cn/base/redacted-base',
      approvalCode: schema.approvalCode,
      recordIds: ['record-test-001'],
      manualInputs: { 'manual-amount': '12.50' },
      idempotencyKey: 'key-template',
    });
    expect(submission.initiate).toHaveBeenCalledWith(
      'redacted-user-token',
      schema.approvalCode,
      expect.arrayContaining([
        { id: 'control-base-text', type: 'input', value: '前缀：来自记录的文本' },
        { id: 'control-manual-amount', type: 'amount', value: '0.3', currency: 'CNY' },
      ]),
      expect.any(String),
    );
  });

  it('blocks a changed approval schema before creating an instance', async () => {
    const { service, submission } = createService();
    const changedSchema: ApprovalSchema = {
      ...schema,
      controls: schema.controls.map((control) => control.id === 'control-fixed-text'
        ? { ...control, name: '固定说明已改名' }
        : control),
    };
    const changedService = new TargetLaunchService(
      {} as FeishuService,
      {
        readApprovalSchema: jest.fn().mockResolvedValue(changedSchema),
        searchLaunchableApprovals: jest.fn().mockResolvedValue({
          items: [{ approvalCode: changedSchema.approvalCode, approvalName: changedSchema.approvalName, isExternal: false }],
          hasMore: false,
        }),
      } as unknown as ApprovalSchemaService,
      { get: jest.fn().mockResolvedValue(profile()) } as unknown as BasePluginProfileService,
      {} as BitableRecordService,
      submission,
      {} as TargetLaunchStateService,
    );
    await expect(changedService.launch('token', 'tenant', 'user', {
      baseUrl: 'https://example.feishu.cn/base/redacted-base',
      approvalCode: schema.approvalCode,
      recordIds: ['record-test-001'],
      idempotencyKey: 'schema-changed',
    })).rejects.toThrow('审批结构已发生变化');
    expect(submission.initiate).not.toHaveBeenCalled();
  });
});
