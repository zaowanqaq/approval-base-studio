import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  and,
  eq,
} from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  BasePluginProfileConfigSchema,
  BasePluginProfileSaveRequestSchema,
} from '../../../shared/approval';
import type {
  BasePluginProfileConfig,
  BasePluginSourceConfiguration,
  BasePluginProfileResponse,
  BasePluginTargetConfiguration,
  BasePluginProfileSaveRequest,
  SourceProvisioningResult,
  SourceSyncState,
  TargetProvisioningResponse,
  TargetProvisioningResult,
} from '../../../shared/approval';
import { basePluginProfiles } from '../../database/schema';
import { baseReferenceFromUrl } from './base-reference';

const DEFAULT_PROFILE_CONFIG: BasePluginProfileConfig = {
  version: 1,
  page: {
    title: 'Approval Base Studio',
    visibleModules: ['approvals'],
    sourceSyncIntervalSeconds: 60,
  },
  businessModules: ['approvals'],
  targetApprovals: [],
  sourceApprovals: [],
};

@Injectable()
export class BasePluginProfileService {
  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
  ) {}

  async get(
    tenantId: string,
    baseUrl: string,
  ): Promise<BasePluginProfileResponse | null> {
    const baseRef = baseReferenceFromUrl(baseUrl);
    const rows = await this.db
      .select()
      .from(basePluginProfiles)
      .where(
        and(
          eq(basePluginProfiles.tenantId, tenantId),
          eq(basePluginProfiles.baseRef, baseRef),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? this.toResponse(row) : null;
  }

  async save(
    tenantId: string,
    userId: string,
    input: unknown,
  ): Promise<BasePluginProfileResponse> {
    const request: BasePluginProfileSaveRequest =
      BasePluginProfileSaveRequestSchema.parse(input) as BasePluginProfileSaveRequest;
    const config: BasePluginProfileConfig =
      BasePluginProfileConfigSchema.parse(request.config) as BasePluginProfileConfig;
    const baseRef = baseReferenceFromUrl(request.baseUrl);
    return this.saveConfig(
      tenantId,
      userId,
      baseRef,
      request.baseName,
      config,
    );
  }

  async mergeTargetProvisioning(
    tenantId: string,
    userId: string,
    baseUrl: string,
    result: TargetProvisioningResult,
  ): Promise<BasePluginProfileResponse> {
    const baseRef = baseReferenceFromUrl(baseUrl);
    const existing = await this.get(tenantId, baseUrl);
    const currentConfig = existing?.config || DEFAULT_PROFILE_CONFIG;
    const target: BasePluginTargetConfiguration = {
      targetTableBinding: {
        targetApprovalCode: result.targetTableBinding.targetApprovalCode,
        baseTableId: result.targetTableBinding.baseTableId,
        baseTableName: result.targetTableBinding.baseTableName,
        writeBackFields: result.targetTableBinding.writeBackFields,
      },
      targetFieldBindings: result.targetFieldBindings,
      approvalSchemaFingerprint: result.approvalSchemaFingerprint,
    };
    const nextConfig: BasePluginProfileConfig = {
      ...currentConfig,
      targetApprovals: [
        ...currentConfig.targetApprovals.filter(
          (item: BasePluginTargetConfiguration) =>
            item.targetTableBinding.targetApprovalCode !==
            target.targetTableBinding.targetApprovalCode,
        ),
        target,
      ],
    };
    return this.saveConfig(
      tenantId,
      userId,
      baseRef,
      existing?.baseName,
      nextConfig,
    );
  }

  async mergeSourceProvisioning(
    tenantId: string,
    userId: string,
    baseUrl: string,
    result: SourceProvisioningResult,
  ): Promise<BasePluginProfileResponse> {
    const baseRef = baseReferenceFromUrl(baseUrl);
    const existing = await this.get(tenantId, baseUrl);
    const currentConfig = existing?.config || DEFAULT_PROFILE_CONFIG;
    const source: BasePluginSourceConfiguration = {
      sourceTableBinding: result.sourceTableBinding,
      syncedFieldBindings: result.syncedFieldBindings,
      syncPolicy: {
        acceptedStatuses: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELED', 'DELETED'],
        tableStrategy: 'one-table-per-source',
        mode: 'api',
        intervalSeconds: 60,
      },
      syncState: {},
    };
    const nextConfig: BasePluginProfileConfig = {
      ...currentConfig,
      sourceApprovals: [
        ...(currentConfig.sourceApprovals || []).filter(
          (item: BasePluginSourceConfiguration) =>
            item.sourceTableBinding.sourceApprovalCode !==
            source.sourceTableBinding.sourceApprovalCode,
        ),
        source,
      ],
    };
    return this.saveConfig(
      tenantId,
      userId,
      baseRef,
      existing?.baseName,
      nextConfig,
    );
  }

  async findSource(
    tenantId: string,
    baseUrl: string,
    approvalCode: string,
  ): Promise<BasePluginSourceConfiguration | null> {
    const profile = await this.get(tenantId, baseUrl);
    return profile?.config.sourceApprovals?.find(
      (item: BasePluginSourceConfiguration) =>
        item.sourceTableBinding.sourceApprovalCode === approvalCode,
    ) || null;
  }

  async listSourceConfigurations(): Promise<Array<{
    tenantId: string;
    baseRef: string;
    baseName?: string;
    source: BasePluginSourceConfiguration;
  }>> {
    const rows = await this.db.select().from(basePluginProfiles);
    return rows.flatMap((row: typeof basePluginProfiles.$inferSelect) => {
      const config = BasePluginProfileConfigSchema.parse(row.config) as BasePluginProfileConfig;
      return (config.sourceApprovals || []).map((source: BasePluginSourceConfiguration) => ({
        tenantId: row.tenantId,
        baseRef: row.baseRef,
        ...(row.baseName ? { baseName: row.baseName } : {}),
        source,
      }));
    });
  }

  async updateSourceSyncState(
    tenantId: string,
    userId: string,
    baseUrl: string,
    approvalCode: string,
    syncState: SourceSyncState,
  ): Promise<BasePluginProfileResponse> {
    const baseRef = baseReferenceFromUrl(baseUrl);
    const existing = await this.get(tenantId, baseUrl);
    if (!existing) throw new BadRequestException('该多维表格尚未配置同步审批流');
    const source = existing.config.sourceApprovals?.find(
      (item: BasePluginSourceConfiguration) =>
        item.sourceTableBinding.sourceApprovalCode === approvalCode,
    );
    if (!source) throw new BadRequestException('该多维表格尚未配置目标同步审批流');
    const nextConfig: BasePluginProfileConfig = {
      ...existing.config,
      sourceApprovals: (existing.config.sourceApprovals || []).map(
        (item: BasePluginSourceConfiguration) => item === source
          ? { ...item, syncState }
          : item,
      ),
    };
    return this.saveConfig(
      tenantId,
      userId,
      baseRef,
      existing.baseName,
      nextConfig,
    );
  }

  async updateSourceSyncStateByRef(
    tenantId: string,
    baseRef: string,
    approvalCode: string,
    syncState: SourceSyncState,
  ): Promise<void> {
    const rows = await this.db
      .select()
      .from(basePluginProfiles)
      .where(
        and(
          eq(basePluginProfiles.tenantId, tenantId),
          eq(basePluginProfiles.baseRef, baseRef),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new BadRequestException('该多维表格尚未配置同步审批流');
    const currentConfig = BasePluginProfileConfigSchema.parse(row.config) as BasePluginProfileConfig;
    const source = currentConfig.sourceApprovals?.find(
      (item: BasePluginSourceConfiguration) =>
        item.sourceTableBinding.sourceApprovalCode === approvalCode,
    );
    if (!source) throw new BadRequestException('该多维表格尚未配置目标同步审批流');
    const nextConfig: BasePluginProfileConfig = {
      ...currentConfig,
      sourceApprovals: (currentConfig.sourceApprovals || []).map(
        (item: BasePluginSourceConfiguration) => item === source ? { ...item, syncState } : item,
      ),
    };
    await this.saveConfig(tenantId, row.createdBy, baseRef, row.baseName || undefined, nextConfig);
  }

  async findTarget(
    tenantId: string,
    baseUrl: string,
    approvalCode: string,
  ): Promise<TargetProvisioningResponse | null> {
    const profile = await this.get(tenantId, baseUrl);
    const target = profile?.config.targetApprovals.find(
      (item: BasePluginTargetConfiguration) =>
        item.targetTableBinding.targetApprovalCode === approvalCode,
    );
    if (!target) return null;
    return {
      targetTableBinding: target.targetTableBinding,
      targetFieldBindings: target.targetFieldBindings,
    };
  }

  private async saveConfig(
    tenantId: string,
    userId: string,
    baseRef: string,
    baseName: string | undefined,
    config: BasePluginProfileConfig,
  ): Promise<BasePluginProfileResponse> {
    const now = new Date();
    const rows = await this.db
      .insert(basePluginProfiles)
      .values({
        tenantId,
        baseRef,
        baseName: baseName || null,
        config,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [basePluginProfiles.tenantId, basePluginProfiles.baseRef],
        set: {
          baseName: baseName || null,
          config,
          createdBy: userId,
          updatedAt: now,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error('保存多维表格插件配置后未返回记录');
    }
    return this.toResponse(row);
  }

  private toResponse(row: typeof basePluginProfiles.$inferSelect): BasePluginProfileResponse {
    const config: BasePluginProfileConfig =
      BasePluginProfileConfigSchema.parse(row.config) as BasePluginProfileConfig;
    return {
      baseRef: row.baseRef,
      ...(row.baseName ? { baseName: row.baseName } : {}),
      config,
    };
  }
}
