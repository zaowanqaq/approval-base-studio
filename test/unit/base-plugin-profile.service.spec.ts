import { BasePluginProfileService } from '../../server/modules/approval/base-plugin-profile.service';
import type { BasePluginProfileConfig } from '../../shared/approval';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';

function profileConfig(): BasePluginProfileConfig {
  return {
    version: 1,
    page: { title: '审批提审', visibleModules: [] },
    businessModules: ['approvals'],
    targetApprovals: [],
  };
}

describe('BasePluginProfileService', () => {
  it('validates the typed Base profile before writing', async () => {
    const insert = jest.fn();
    const service = new BasePluginProfileService(
      { insert } as unknown as PostgresJsDatabase,
    );

    await expect(
      service.save('tenant-redacted', 'user-redacted', {
        baseUrl: 'https://example.feishu.cn/base/redacted-base',
        config: {
          ...profileConfig(),
          targetApprovals: [
            {
              targetTableBinding: {
                targetApprovalCode: 'approval-target-001',
                baseTableId: 'table-target-001',
                baseTableName: '提审表',
                writeBackFields: {
                  instanceCodeFieldId: 'field-instance',
                  statusFieldId: 'field-status',
                  submittedAtFieldId: 'field-submitted',
                  batchIdFieldId: 'field-batch',
                },
              },
              targetFieldBindings: [],
            },
            {
              targetTableBinding: {
                targetApprovalCode: 'approval-target-001',
                baseTableId: 'table-target-002',
                baseTableName: '重复提审表',
                writeBackFields: {
                  instanceCodeFieldId: 'field-instance-2',
                  statusFieldId: 'field-status-2',
                  submittedAtFieldId: 'field-submitted-2',
                  batchIdFieldId: 'field-batch-2',
                },
              },
              targetFieldBindings: [],
            },
          ],
        },
      }),
    ).rejects.toThrow('不能重复配置同一目标审批流');
    expect(insert).not.toHaveBeenCalled();
  });

  it('isolates profiles by a hashed Base reference', async () => {
    const returnedRow = {
      baseRef: 'redacted-ref',
      baseName: null,
      config: profileConfig(),
    };
    const returning = jest.fn().mockResolvedValue([returnedRow]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    const service = new BasePluginProfileService(
      { insert } as unknown as PostgresJsDatabase,
    );

    await service.save('tenant-redacted', 'user-redacted', {
      baseUrl: 'https://example.feishu.cn/base/redacted-base-a',
      config: profileConfig(),
    });
    await service.save('tenant-redacted', 'user-redacted', {
      baseUrl: 'https://example.feishu.cn/base/redacted-base-b',
      config: profileConfig(),
    });

    const firstValues = values.mock.calls[0][0] as { baseRef: string };
    const secondValues = values.mock.calls[1][0] as { baseRef: string };
    expect(firstValues.baseRef).not.toBe('redacted-base-a');
    expect(secondValues.baseRef).not.toBe('redacted-base-b');
    expect(firstValues.baseRef).not.toBe(secondValues.baseRef);
  });
});
