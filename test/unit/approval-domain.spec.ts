import {
  findExactTargetAutoMatch,
  findSyncedFieldBinding,
  mergeSourceProvisioningResult,
  mergeTargetProvisioningResult,
  validateApprovalPluginConfig,
  type ApprovalPluginConfig,
  type SourceProvisioningResult,
  type SyncedFieldBinding,
  type TargetProvisioningResult,
} from '../../shared/approval';

function syncedBinding(
  overrides: Partial<SyncedFieldBinding> = {},
): SyncedFieldBinding {
  return {
    sourceApprovalCode: 'approval-source-001',
    sourceControlId: 'control-source-name',
    sourceControlName: '来源姓名',
    sourceControlType: 'input',
    baseTableId: 'table-source-001',
    baseFieldId: 'field-source-name',
    baseFieldName: '来源姓名',
    baseFieldType: 'text',
    ...overrides,
  };
}

describe('approval domain model', () => {
  it('allows one approval connection to have source and target roles', () => {
    const config: ApprovalPluginConfig = {
      version: 1,
      connections: [
        {
          approvalCode: 'approval-shared-001',
          approvalName: '脱敏审批',
          roles: ['source', 'target'],
          syncPolicy: {
            acceptedStatuses: ['APPROVED'],
            tableStrategy: 'one-table-per-source',
          },
          launchPolicy: { batchMode: 'single-record', idempotency: 'batch-id' },
        },
      ],
      sourceTableBindings: [],
      sourceConnectorPlans: [],
      syncedFieldBindings: [],
      targetTableBindings: [],
      targetFieldBindings: [],
    };

    expect(validateApprovalPluginConfig(config)).toEqual(config);
  });

  it('rejects duplicate stable bindings and role-specific missing policies', () => {
    const config = {
      version: 1,
      connections: [
        {
          approvalCode: 'approval-source-001',
          approvalName: '脱敏来源审批',
          roles: ['source'],
        },
      ],
      sourceTableBindings: [],
      sourceConnectorPlans: [],
      syncedFieldBindings: [
        syncedBinding(),
        syncedBinding({ baseFieldId: 'field-other' }),
      ],
      targetTableBindings: [],
      targetFieldBindings: [],
    };

    expect(() => validateApprovalPluginConfig(config)).toThrow('syncPolicy');
    expect(() =>
      validateApprovalPluginConfig({
        ...config,
        connections: [
          {
            ...config.connections[0],
            syncPolicy: {
              acceptedStatuses: ['APPROVED'],
              tableStrategy: 'one-table-per-source',
            },
          },
        ],
      }),
    ).toThrow('同一来源审批控件只能绑定一个多维表格字段');
  });

  it('resolves by approval and control IDs after display names change', () => {
    const binding = syncedBinding({ baseFieldName: '用户改过的展示名称' });

    expect(
      findSyncedFieldBinding(
        [binding],
        'approval-source-001',
        'control-source-name',
      ),
    ).toBe(binding);
    expect(
      findSyncedFieldBinding(
        [binding],
        'approval-source-001',
        '用户改过的展示名称',
      ),
    ).toBeUndefined();
  });

  it('only suggests an exact name and type match', () => {
    const binding = syncedBinding({
      baseFieldName: '目标姓名',
      baseFieldType: 'text',
    });

    expect(
      findExactTargetAutoMatch({ name: ' 目标 姓名 ', type: 'text' }, [
        binding,
      ]),
    ).toBe(binding);
    expect(
      findExactTargetAutoMatch({ name: '目标姓名', type: 'number' }, [binding]),
    ).toBeUndefined();
  });

  it('merges source table and field bindings by approval code', () => {
    const config: ApprovalPluginConfig = {
      version: 1,
      connections: [],
      sourceTableBindings: [],
      sourceConnectorPlans: [],
      syncedFieldBindings: [],
      targetTableBindings: [],
      targetFieldBindings: [],
    };
    const result: SourceProvisioningResult = {
      sourceTableBinding: {
        sourceApprovalCode: 'approval-source-001',
        baseAppToken: 'redacted-base-token',
        baseTableId: 'table-source-001',
        baseTableName: '脱敏审批',
        systemFields: {
          instanceCodeFieldId: 'field-instance-code',
          statusFieldId: 'field-status',
          submittedAtFieldId: 'field-submitted-at',
          syncedAtFieldId: 'field-synced-at',
        },
        baseUrl: 'https://example.invalid/base/redacted',
      },
      syncedFieldBindings: [syncedBinding()],
      connectorPlan: {
        sourceApprovalCode: 'approval-source-001',
        baseTableId: 'table-source-001',
        status: 'api-sync-enabled',
        mode: 'api',
        mapping: 'source-control-id-to-base-field-id',
        bindings: [
          {
            sourceControlId: 'control-source-name',
            baseFieldId: 'field-source-name',
          },
        ],
        systemFields: {
          instanceCodeFieldId: 'field-instance-code',
          statusFieldId: 'field-status',
          submittedAtFieldId: 'field-submitted-at',
          syncedAtFieldId: 'field-synced-at',
        },
      },
    };

    expect(mergeSourceProvisioningResult(config, result)).toMatchObject({
      sourceTableBindings: [result.sourceTableBinding],
      sourceConnectorPlans: [result.connectorPlan],
      syncedFieldBindings: result.syncedFieldBindings,
    });
  });

  it('merges target table and field bindings by approval code', () => {
    const config: ApprovalPluginConfig = {
      version: 1,
      connections: [],
      sourceTableBindings: [],
      sourceConnectorPlans: [],
      syncedFieldBindings: [],
      targetTableBindings: [],
      targetFieldBindings: [],
    };
    const result: TargetProvisioningResult = {
      targetTableBinding: {
        targetApprovalCode: 'approval-target-001',
        baseAppToken: 'redacted-base-token',
        baseTableId: 'table-target-001',
        baseTableName: '脱敏目标审批-提审',
        writeBackFields: {
          instanceCodeFieldId: 'field-instance-code',
          statusFieldId: 'field-status',
          submittedAtFieldId: 'field-submitted-at',
          batchIdFieldId: 'field-batch-id',
        },
        baseUrl: 'https://example.feishu.cn/base/redacted-base',
      },
      targetFieldBindings: [
        {
          targetApprovalCode: 'approval-target-001',
          targetControlId: 'control-target-name',
          targetControlName: '姓名',
          targetControlType: 'input',
          baseTableId: 'table-target-001',
          baseFieldId: 'field-target-name',
          baseFieldName: '姓名',
          baseFieldType: 'text',
        },
      ],
    };

    expect(mergeTargetProvisioningResult(config, result)).toMatchObject({
      targetTableBindings: [result.targetTableBinding],
      targetFieldBindings: result.targetFieldBindings,
    });
  });
});
