import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import {
  ApprovalDefinitionSearchResponseSchema,
} from '../../../shared/approval';
import type {
  ApprovalControl,
  ApprovalDefinitionSearchResponse,
  ApprovalSchema,
} from '../../../shared/approval';
import { FeishuService } from './feishu.service';

export interface ApprovalControlDefinition {
  id: string;
  name: string;
  required?: boolean;
  type: string;
  visible?: boolean;
  display_condition?: unknown;
  children?: ApprovalControlDefinition[];
  [key: string]: unknown;
}

export interface ApprovalDefinition {
  approval_name?: string;
  form?: string | ApprovalControlDefinition[];
  node_list?: Array<{
    name?: string;
    need_approver?: boolean;
    [key: string]: unknown;
  }>;
}

interface LaunchableApprovalDefinition {
  approval_code?: string;
  approval_name?: string;
  create_link?: string;
  is_external?: boolean;
}

interface LaunchableApprovalSearchResponse {
  approvals?: LaunchableApprovalDefinition[];
  has_more?: boolean;
  page_token?: string;
}

@Injectable()
export class ApprovalSchemaService {
  constructor(private readonly feishu: FeishuService) {}

  async readApprovalDefinition(
    token: string,
    approvalCode: string,
  ): Promise<ApprovalDefinition> {
    return this.feishu.api<ApprovalDefinition>(
      `approval/v4/approvals/${approvalCode}/detail`,
      token,
    );
  }

  async readApprovalSchema(
    token: string,
    approvalCode: string,
  ): Promise<ApprovalSchema> {
    const definition = await this.readApprovalDefinition(token, approvalCode);
    const schema: ApprovalSchema = {
      approvalCode,
      approvalName: definition.approval_name || '',
      controls: this.definitionControls(definition).map(
        (control: ApprovalControlDefinition) => this.toApprovalControl(control),
      ),
      nodes: (definition.node_list || []).map(
        (node: {
          name?: string;
          need_approver?: boolean;
          [key: string]: unknown;
        }) => ({
          name: node.name,
          requiresApproverSelection: node.need_approver,
          raw: node,
        }),
      ),
      fetchedAt: new Date().toISOString(),
    };
    return {
      ...schema,
      schemaFingerprint: approvalSchemaFingerprint(schema),
    };
  }

  async searchLaunchableApprovals(
    token: string,
    keyword: string,
    pageToken?: string,
    pageSize = 50,
  ): Promise<ApprovalDefinitionSearchResponse> {
    const response = await this.feishu.api<LaunchableApprovalSearchResponse>(
      'approval/v4/approvals/search_launchable',
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          keyword,
          locale: 'zh-CN',
          page_size: pageSize,
          ...(pageToken ? { page_token: pageToken } : {}),
        }),
      },
    );
    const result: ApprovalDefinitionSearchResponse = {
      items: (response.approvals || [])
        .filter(
          (item: LaunchableApprovalDefinition) =>
            Boolean(item.approval_code && item.approval_name),
        )
        .map((item: LaunchableApprovalDefinition) => ({
          approvalCode: item.approval_code as string,
          approvalName: item.approval_name as string,
          isExternal: item.is_external === true,
          ...(item.create_link ? { createLink: item.create_link } : {}),
        })),
      hasMore: response.has_more === true,
      ...(response.page_token ? { pageToken: response.page_token } : {}),
    };
    return ApprovalDefinitionSearchResponseSchema.parse(
      result,
    ) as ApprovalDefinitionSearchResponse;
  }

  private definitionControls(
    definition: ApprovalDefinition,
  ): ApprovalControlDefinition[] {
    if (!definition.form) return [];
    if (Array.isArray(definition.form)) return definition.form;
    try {
      const parsed = JSON.parse(definition.form) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item: unknown): item is ApprovalControlDefinition =>
            this.isControl(item),
          )
        : [];
    } catch {
      return [];
    }
  }

  private isControl(value: unknown): value is ApprovalControlDefinition {
    if (!value || typeof value !== 'object') return false;
    const object = value as Record<string, unknown>;
    return typeof object.id === 'string' && typeof object.type === 'string';
  }

  private nestedControls(
    control: ApprovalControlDefinition,
  ): ApprovalControlDefinition[] | undefined {
    const candidates = [control.children, control.fields, control.controls];
    const children = candidates.find(
      (candidate: unknown): candidate is unknown[] => Array.isArray(candidate),
    );
    if (!children) return undefined;
    return children.filter((item: unknown): item is ApprovalControlDefinition =>
      this.isControl(item),
    );
  }

  private toApprovalControl(
    control: ApprovalControlDefinition,
  ): ApprovalControl {
    const children = this.nestedControls(control)?.map(
      (child: ApprovalControlDefinition) => this.toApprovalControl(child),
    );
    return {
      id: control.id,
      name: control.name || '',
      type: control.type,
      required: control.required === true,
      visible: control.visible !== false,
      ...(children?.length ? { children } : {}),
      raw: control,
    };
  }
}

export function approvalSchemaFingerprint(schema: ApprovalSchema): string {
  const normalized = {
    approvalCode: schema.approvalCode,
    approvalName: schema.approvalName,
    controls: schema.controls.map((control: ApprovalControl) =>
      fingerprintControl(control)),
    nodes: schema.nodes.map((node) => ({
      name: node.name || '',
      requiresApproverSelection: node.requiresApproverSelection === true,
      id: typeof node.raw?.id === 'string' ? node.raw.id : '',
      nodeType: typeof node.raw?.node_type === 'string' ? node.raw.node_type : '',
    })),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function fingerprintControl(control: ApprovalControl): Record<string, unknown> {
  const raw = control.raw || {};
  return {
    id: control.id,
    name: control.name,
    type: control.type,
    required: control.required,
    visible: control.visible,
    options: raw.option ?? raw.options ?? raw.option_list ?? null,
    displayCondition: raw.display_condition ?? null,
    children: (control.children || []).map((child: ApprovalControl) =>
      fingerprintControl(child)),
  };
}
