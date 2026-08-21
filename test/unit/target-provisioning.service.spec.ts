import type { ApprovalSchemaService } from '../../server/modules/approval/approval-schema.service';
import type { FeishuService } from '../../server/modules/approval/feishu.service';
import { TargetProvisioningService } from '../../server/modules/approval/target-provisioning.service';
import type { ApprovalSchema } from '../../shared/approval';

describe('TargetProvisioningService', () => {
  it('creates a submit table in an existing Base and captures stable IDs', async () => {
    const schema: ApprovalSchema = {
      approvalCode: 'approval-target-001',
      approvalName: '脱敏目标审批',
      controls: [
        {
          id: 'control-target-text-001',
          name: '申请说明',
          type: 'textarea',
          required: true,
          visible: true,
        },
        {
          id: 'control-target-amount-001',
          name: '申请金额',
          type: 'amount',
          required: true,
          visible: true,
        },
      ],
      nodes: [],
    };
    const api = jest.fn();
    api.mockImplementation((path: string) => {
      if (path.endsWith('/tables')) {
        return Promise.resolve({ table_id: 'table-target-001' });
      }
      if (path.endsWith('/fields')) {
        const fieldCount = api.mock.calls.filter((call: unknown[]) =>
          String(call[0]).endsWith('/fields'),
        ).length;
        return Promise.resolve({ field: { field_id: `field-target-${fieldCount}` } });
      }
      return Promise.resolve({});
    });

    const service = new TargetProvisioningService(
      { api } as unknown as FeishuService,
      {
        readApprovalSchema: jest.fn().mockResolvedValue(schema),
      } as unknown as ApprovalSchemaService,
    );

    const result = await service.provision('redacted-user-token', {
      approvalCode: 'approval-target-001',
      destination: {
        kind: 'existing-base',
        baseUrl: 'https://example.feishu.cn/base/redacted-base',
      },
    });

    expect(result.targetTableBinding).toMatchObject({
      targetApprovalCode: 'approval-target-001',
      baseAppToken: 'redacted-base',
      baseTableId: 'table-target-001',
      baseTableName: '脱敏目标审批-提审',
    });
    expect(result.targetFieldBindings).toMatchObject([
      {
        targetControlId: 'control-target-text-001',
        baseFieldId: 'field-target-1',
        baseFieldType: 'text',
      },
      {
        targetControlId: 'control-target-amount-001',
        baseFieldId: 'field-target-2',
        baseFieldType: 'amount',
      },
    ]);
    expect(result.targetTableBinding.writeBackFields).toMatchObject({
      instanceCodeFieldId: 'field-target-3',
      statusFieldId: 'field-target-4',
      submittedAtFieldId: 'field-target-5',
      batchIdFieldId: 'field-target-6',
    });
    expect(api).not.toHaveBeenCalledWith(
      'bitable/v1/apps',
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects detail controls before creating a submit table', async () => {
    const api = jest.fn();
    const schema: ApprovalSchema = {
      approvalCode: 'approval-target-002',
      approvalName: '脱敏明细目标审批',
      controls: [
        {
          id: 'control-detail-001',
          name: '明细',
          type: 'field_list',
          required: false,
          visible: true,
          children: [
            {
              id: 'control-child-001',
              name: '金额',
              type: 'amount',
              required: true,
              visible: true,
            },
          ],
        },
      ],
      nodes: [],
    };
    const service = new TargetProvisioningService(
      { api } as unknown as FeishuService,
      {
        readApprovalSchema: jest.fn().mockResolvedValue(schema),
      } as unknown as ApprovalSchemaService,
    );

    await expect(
      service.provision('redacted-user-token', {
        approvalCode: 'approval-target-002',
        destination: {
          kind: 'existing-base',
          baseUrl: 'https://example.feishu.cn/base/redacted-base',
        },
      }),
    ).rejects.toThrow('暂不自动展平明细表');
    expect(api).not.toHaveBeenCalled();
  });

  it('keeps automatic bindings and validates explicit field sources', async () => {
    const schema: ApprovalSchema = {
      approvalCode: 'approval-target-003',
      approvalName: '脱敏来源目标审批',
      controls: [
        {
          id: 'control-target-manual-001',
          name: '补充说明',
          type: 'input',
          required: false,
          visible: true,
        },
      ],
      nodes: [],
    };
    const api = jest.fn().mockImplementation((path: string) => {
      if (path.endsWith('/tables')) return Promise.resolve({ table_id: 'table-target-003' });
      if (path.endsWith('/fields')) {
        const fieldCount = api.mock.calls.filter((call: unknown[]) =>
          String(call[0]).endsWith('/fields'),
        ).length;
        return Promise.resolve({ field: { field_id: `field-target-003-${fieldCount}` } });
      }
      return Promise.resolve({});
    });
    const service = new TargetProvisioningService(
      { api } as unknown as FeishuService,
      { readApprovalSchema: jest.fn().mockResolvedValue(schema) } as unknown as ApprovalSchemaService,
    );

    const result = await service.provision('redacted-user-token', {
      approvalCode: 'approval-target-003',
      destination: {
        kind: 'existing-base',
        baseUrl: 'https://example.feishu.cn/base/redacted-base',
      },
      fieldSources: {
        'control-target-manual-001': {
          kind: 'manual',
          inputKey: '补充说明输入',
          inputType: 'text',
        },
      },
    });

    expect(result.targetFieldBindings[0]?.source).toEqual({
      kind: 'manual',
      inputKey: '补充说明输入',
      inputType: 'text',
    });
    await expect(
      service.provision('redacted-user-token', {
        approvalCode: 'approval-target-003',
        destination: {
          kind: 'existing-base',
          baseUrl: 'https://example.feishu.cn/base/redacted-base',
        },
        fieldSources: {
          'control-target-manual-001': {
            kind: 'manual',
            inputKey: '',
            inputType: 'text',
          },
        },
      }),
    ).rejects.toThrow();
  });

  it('recovers a table and fields after an uncertain create response', async () => {
    const schema: ApprovalSchema = {
      approvalCode: 'approval-target-retry-001',
      approvalName: '脱敏幂等目标审批',
      controls: [{
        id: 'control-retry-text-001',
        name: '申请说明',
        type: 'input',
        required: true,
        visible: true,
      }],
      nodes: [],
    };
    const api = jest.fn().mockImplementation((path: string, _token: string, options?: { method?: string }) => {
      if (options?.method === 'POST' && path.endsWith('/tables')) {
        throw new Error('创建结果未知');
      }
      if (path.includes('/tables?')) {
        return Promise.resolve({ items: [{ table_id: 'table-retry-001', name: '脱敏幂等目标审批-提审' }] });
      }
      if (options?.method === 'POST' && path.endsWith('/fields')) {
        throw new Error('字段创建结果未知');
      }
      if (path.includes('/fields?')) {
        return Promise.resolve({
          items: [
            { field_id: 'field-retry-text', field_name: '申请说明', type: 1 },
            { field_id: 'field-retry-instance', field_name: '审批实例Code', type: 1 },
            { field_id: 'field-retry-status', field_name: '审批状态', type: 1 },
            { field_id: 'field-retry-submitted', field_name: '提交时间', type: 5 },
            { field_id: 'field-retry-batch', field_name: '批次ID', type: 1 },
          ],
        });
      }
      return Promise.resolve({});
    });
    const service = new TargetProvisioningService(
      { api } as unknown as FeishuService,
      { readApprovalSchema: jest.fn().mockResolvedValue(schema) } as unknown as ApprovalSchemaService,
    );

    const result = await service.provision('redacted-user-token', {
      approvalCode: schema.approvalCode,
      destination: {
        kind: 'existing-base',
        baseUrl: 'https://example.feishu.cn/base/redacted-base',
      },
    });

    expect(result.targetTableBinding.baseTableId).toBe('table-retry-001');
    expect(result.targetFieldBindings[0]?.baseFieldId).toBe('field-retry-text');
    expect(result.targetTableBinding.writeBackFields).toEqual({
      instanceCodeFieldId: 'field-retry-instance',
      statusFieldId: 'field-retry-status',
      submittedAtFieldId: 'field-retry-submitted',
      batchIdFieldId: 'field-retry-batch',
    });
  });
});
