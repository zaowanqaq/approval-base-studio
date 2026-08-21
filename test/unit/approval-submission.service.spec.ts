import { ApprovalSubmissionService } from '../../server/modules/payment/approval-submission.service';
import type { FeishuService } from '../../server/modules/payment/feishu.service';

describe('ApprovalSubmissionService', () => {
  it('uses the official target instance endpoint with the current operator identity', async () => {
    const api = jest.fn((path: string) => {
      if (path === 'authen/v1/user_info') {
        return Promise.resolve({ open_id: 'ou-redacted-operator' });
      }
      return Promise.resolve({ instance_code: 'instance-redacted-001' });
    });
    const feishu = {
      api,
      tenantAccessToken: jest.fn().mockResolvedValue('tenant-token-redacted'),
    } as unknown as FeishuService;
    const service = new ApprovalSubmissionService(feishu);

    await expect(service.initiate(
      'user-token-redacted',
      'approval-code-redacted',
      [{ id: 'control-redacted', type: 'input', value: '脱敏值' }],
      'uuid-redacted',
    )).resolves.toEqual({ instance_code: 'instance-redacted-001' });

    expect(api).toHaveBeenNthCalledWith(
      1,
      'authen/v1/user_info',
      'user-token-redacted',
    );
    expect(feishu.tenantAccessToken).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenNthCalledWith(
      2,
      'approval/v4/instances',
      'tenant-token-redacted',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          approval_code: 'approval-code-redacted',
          open_id: 'ou-redacted-operator',
          form: JSON.stringify([{ id: 'control-redacted', type: 'input', value: '脱敏值' }]),
          uuid: 'uuid-redacted',
        }),
      }),
    );
  });
});
