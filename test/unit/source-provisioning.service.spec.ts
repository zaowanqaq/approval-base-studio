import type { ApprovalSchemaService } from '../../server/modules/payment/approval-schema.service';
import type { FeishuService } from '../../server/modules/payment/feishu.service';
import { SourceProvisioningService } from '../../server/modules/payment/source-provisioning.service';
import type { ApprovalSchema } from '../../shared/approval';

describe('SourceProvisioningService', () => {
  it('creates one Base table and captures field IDs for each control', async () => {
    const schema: ApprovalSchema = {
      approvalCode: 'approval-source-001',
      approvalName: '脱敏来源审批',
      controls: [
        {
          id: 'control-text-001',
          name: '申请说明',
          type: 'textarea',
          required: true,
          visible: true,
        },
        {
          id: 'control-amount-001',
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
      if (path === 'bitable/v1/apps') {
        return Promise.resolve({
          app: {
            app_token: 'redacted-base-token',
            default_table_id: 'table-source-001',
            url: 'https://example.invalid/base/redacted',
          },
        });
      }
      if (path.endsWith('/fields')) {
        const fieldId = api.mock.calls.filter((call: unknown[]) =>
          String(call[0]).endsWith('/fields'),
        ).length;
        return Promise.resolve({
          field: { field_id: `field-source-${fieldId}` },
        });
      }
      return Promise.resolve({});
    });

    const readApprovalSchema = jest.fn().mockResolvedValue(schema);
    const feishu = { api } as unknown as FeishuService;
    const approvalSchemas = {
      readApprovalSchema,
    } as unknown as ApprovalSchemaService;
    const service = new SourceProvisioningService(feishu, approvalSchemas);

    const result = await service.provision('redacted-user-token', {
      approvalCode: 'approval-source-001',
      destination: { kind: 'new-base' },
    });

    expect(readApprovalSchema).toHaveBeenCalledWith(
      'redacted-user-token',
      'approval-source-001',
    );
    expect(result.sourceTableBinding).toMatchObject({
      sourceApprovalCode: 'approval-source-001',
      baseTableId: 'table-source-001',
      baseTableName: '脱敏来源审批',
    });
    expect(result.syncedFieldBindings).toMatchObject([
      {
        sourceControlId: 'control-text-001',
        baseFieldId: 'field-source-1',
        baseFieldType: 'text',
      },
      {
        sourceControlId: 'control-amount-001',
        baseFieldId: 'field-source-2',
        baseFieldType: 'amount',
      },
    ]);
    expect(result.connectorPlan).toMatchObject({
      sourceApprovalCode: 'approval-source-001',
      baseTableId: 'table-source-001',
      status: 'api-sync-enabled',
      mode: 'api',
      mapping: 'source-control-id-to-base-field-id',
      bindings: [
        { sourceControlId: 'control-text-001', baseFieldId: 'field-source-1' },
        { sourceControlId: 'control-amount-001', baseFieldId: 'field-source-2' },
      ],
    });
    expect(api).toHaveBeenCalledWith(
      'bitable/v1/apps/redacted-base-token/tables/table-source-001',
      'redacted-user-token',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('rejects detail controls before creating a Base', async () => {
    const api = jest.fn();
    const schema: ApprovalSchema = {
      approvalCode: 'approval-source-002',
      approvalName: '脱敏明细审批',
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
    const service = new SourceProvisioningService(
      { api } as unknown as FeishuService,
      {
        readApprovalSchema: jest.fn().mockResolvedValue(schema),
      } as unknown as ApprovalSchemaService,
    );

    await expect(
      service.provision('redacted-user-token', {
        approvalCode: 'approval-source-002',
        destination: { kind: 'new-base' },
      }),
    ).rejects.toThrow('暂不自动展平明细表');
    expect(api).not.toHaveBeenCalled();
  });

  it('creates a second approval table inside an existing Base', async () => {
    const api = jest.fn();
    api.mockImplementation((path: string) => {
      if (path.endsWith('/tables')) {
        return Promise.resolve({ table_id: 'table-source-002' });
      }
      if (path.endsWith('/fields')) {
        return Promise.resolve({ field: { field_id: 'field-source-003' } });
      }
      return Promise.resolve({});
    });
    const schema: ApprovalSchema = {
      approvalCode: 'approval-source-003',
      approvalName: '脱敏第二审批',
      controls: [
        {
          id: 'control-text-003',
          name: '备注',
          type: 'input',
          required: false,
          visible: true,
        },
      ],
      nodes: [],
    };
    const service = new SourceProvisioningService(
      { api } as unknown as FeishuService,
      {
        readApprovalSchema: jest.fn().mockResolvedValue(schema),
      } as unknown as ApprovalSchemaService,
    );

    const result = await service.provision('redacted-user-token', {
      approvalCode: 'approval-source-003',
      destination: {
        kind: 'existing-base',
        baseAppToken: 'redacted-base-token',
        tableName: '第二审批表',
      },
    });

    expect(result.sourceTableBinding).toMatchObject({
      baseAppToken: 'redacted-base-token',
      baseTableId: 'table-source-002',
      baseTableName: '第二审批表',
    });
    expect(api).toHaveBeenCalledWith(
      'bitable/v1/apps/redacted-base-token/tables',
      'redacted-user-token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(
      api.mock.calls.some((call: unknown[]) => call[0] === 'bitable/v1/apps'),
    ).toBe(false);
  });
});
