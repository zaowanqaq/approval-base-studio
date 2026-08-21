import type { FeishuService } from '../../server/modules/payment/feishu.service';
import type { ApprovalDefinition } from '../../server/modules/payment/approval-schema.service';
import { ApprovalSchemaService, approvalSchemaFingerprint } from '../../server/modules/payment/approval-schema.service';
import type { ApprovalSchema } from '../../shared/approval';

describe('ApprovalSchemaService', () => {
  it('normalizes a sanitized approval definition and preserves detail children', async () => {
    const definition: ApprovalDefinition = {
      approval_name: '脱敏付款审批',
      form: JSON.stringify([
        {
          id: 'widget-text-001',
          name: '申请说明',
          type: 'textarea',
          required: true,
        },
        {
          id: 'widget-table-001',
          name: '明细',
          type: 'field_list',
          required: false,
          children: [
            {
              id: 'widget-number-001',
              name: '金额',
              type: 'amount',
              required: true,
            },
          ],
        },
      ]),
      node_list: [{ name: '直属负责人', need_approver: false }],
    };
    const api = jest.fn(
      (path: string, token: string): Promise<ApprovalDefinition> => {
        expect(path).toBe('approval/v4/approvals/approval-test-001/detail');
        expect(token).toBe('redacted-user-token');
        return Promise.resolve(definition);
      },
    );
    const feishu = { api } as unknown as FeishuService;
    const service = new ApprovalSchemaService(feishu);

    const schema = await service.readApprovalSchema(
      'redacted-user-token',
      'approval-test-001',
    );

    expect(schema.approvalCode).toBe('approval-test-001');
    expect(schema.approvalName).toBe('脱敏付款审批');
    expect(schema.controls[0]).toMatchObject({
      id: 'widget-text-001',
      type: 'textarea',
      required: true,
    });
    expect(schema.controls[1]?.children?.[0]).toMatchObject({
      id: 'widget-number-001',
      type: 'amount',
      required: true,
    });
    expect(schema.nodes[0]).toMatchObject({
      name: '直属负责人',
      requiresApproverSelection: false,
    });
  });

  it('searches launchable approvals with the official launchable endpoint', async () => {
    const api = jest.fn().mockResolvedValue({
      approvals: [
        {
          approval_code: 'approval-launchable-001',
          approval_name: '脱敏可发起审批',
          is_external: false,
        },
        {
          approval_code: 'approval-external-001',
          approval_name: '脱敏三方审批',
          is_external: true,
          create_link: 'https://example.invalid/approval/create',
        },
      ],
      has_more: true,
      page_token: 'redacted-next-page',
    });
    const service = new ApprovalSchemaService(
      { api } as unknown as FeishuService,
    );

    const result = await service.searchLaunchableApprovals(
      'redacted-user-token',
      '审批',
      undefined,
      20,
    );

    expect(api).toHaveBeenCalledWith(
      'approval/v4/approvals/search_launchable',
      'redacted-user-token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          keyword: '审批',
          locale: 'zh-CN',
          page_size: 20,
        }),
      }),
    );
    expect(result).toEqual({
      items: [
        {
          approvalCode: 'approval-launchable-001',
          approvalName: '脱敏可发起审批',
          isExternal: false,
        },
        {
          approvalCode: 'approval-external-001',
          approvalName: '脱敏三方审批',
          isExternal: true,
          createLink: 'https://example.invalid/approval/create',
        },
      ],
      hasMore: true,
      pageToken: 'redacted-next-page',
    });
  });

  it('changes the fingerprint when a control option or node identity changes', () => {
    const base: ApprovalSchema = {
      approvalCode: 'approval-fingerprint-001',
      approvalName: '脱敏指纹测试审批',
      controls: [{
        id: 'control-radio-001',
        name: '类型',
        type: 'radioV2',
        required: true,
        visible: true,
        raw: { option: [{ key: 'A', name: '选项 A' }] },
      }],
      nodes: [{
        name: '审批人',
        requiresApproverSelection: false,
        raw: { id: 'node-001', node_type: 'AND' },
      }],
    };
    const optionChanged: ApprovalSchema = {
      ...base,
      controls: [{
        ...base.controls[0],
        raw: { option: [{ key: 'B', name: '选项 B' }] },
      }],
    };
    const nodeChanged: ApprovalSchema = {
      ...base,
      nodes: [{ ...base.nodes[0], raw: { id: 'node-002', node_type: 'AND' } }],
    };

    expect(approvalSchemaFingerprint(optionChanged)).not.toBe(approvalSchemaFingerprint(base));
    expect(approvalSchemaFingerprint(nodeChanged)).not.toBe(approvalSchemaFingerprint(base));
  });
});
