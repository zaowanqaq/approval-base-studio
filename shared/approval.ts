import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);

export const ApprovalRoleSchema = z.enum(['source', 'target']);
export type ApprovalRole = z.infer<typeof ApprovalRoleSchema>;

export const ApprovalControlTypeSchema = nonEmptyString;
export type ApprovalControlType = z.infer<typeof ApprovalControlTypeSchema>;

export interface ApprovalControl {
  id: string;
  name: string;
  type: ApprovalControlType;
  required: boolean;
  visible: boolean;
  children?: ApprovalControl[];
  raw?: Record<string, unknown>;
}

export const ApprovalControlSchema = z.lazy(() =>
  z.object({
    id: nonEmptyString,
    name: z.string(),
    type: ApprovalControlTypeSchema,
    required: z.boolean(),
    visible: z.boolean(),
    children: z.array(ApprovalControlSchema).optional(),
    raw: z.record(z.string(), z.unknown()).optional(),
  }),
);

export interface ApprovalNode {
  name?: string;
  requiresApproverSelection?: boolean;
  raw?: Record<string, unknown>;
}

export const ApprovalNodeSchema = z.object({
  name: z.string().optional(),
  requiresApproverSelection: z.boolean().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

export interface ApprovalSchema {
  approvalCode: string;
  approvalName: string;
  controls: ApprovalControl[];
  nodes: ApprovalNode[];
  fetchedAt?: string;
  schemaFingerprint?: string;
}

export const ApprovalSchemaSchema = z.object({
  approvalCode: nonEmptyString,
  approvalName: nonEmptyString,
  controls: z.array(ApprovalControlSchema),
  nodes: z.array(ApprovalNodeSchema),
  fetchedAt: z.string().datetime().optional(),
  schemaFingerprint: nonEmptyString.optional(),
});

export interface ApprovalDefinitionSummary {
  approvalCode: string;
  approvalName: string;
  isExternal: boolean;
  createLink?: string;
}

export const ApprovalDefinitionSummarySchema = z.object({
  approvalCode: nonEmptyString,
  approvalName: nonEmptyString,
  isExternal: z.boolean(),
  createLink: z.string().url().optional(),
});

export interface ApprovalDefinitionSearchResponse {
  items: ApprovalDefinitionSummary[];
  hasMore: boolean;
  pageToken?: string;
}

export const ApprovalDefinitionSearchResponseSchema = z.object({
  items: z.array(ApprovalDefinitionSummarySchema),
  hasMore: z.boolean(),
  pageToken: nonEmptyString.optional(),
});

export interface SyncPolicy {
  acceptedStatuses: string[];
  tableStrategy: 'one-table-per-source';
  mode?: 'api';
}

export const SyncPolicySchema = z.object({
  acceptedStatuses: z.array(nonEmptyString).min(1),
  tableStrategy: z.literal('one-table-per-source'),
  mode: z.literal('api').optional(),
});

export interface SourceSyncState {
  lastSyncAt?: string;
  lastStartTime?: string;
  lastEndTime?: string;
  lastSyncedCount?: number;
  lastSkippedCount?: number;
  lastError?: string;
}

export const SourceSyncStateSchema = z.object({
  lastSyncAt: z.string().datetime().optional(),
  lastStartTime: z.string().datetime().optional(),
  lastEndTime: z.string().datetime().optional(),
  lastSyncedCount: z.number().int().nonnegative().optional(),
  lastSkippedCount: z.number().int().nonnegative().optional(),
  lastError: z.string().optional(),
});

export interface LaunchWriteBackFieldIds {
  instanceCodeFieldId?: string;
  statusFieldId?: string;
  submittedAtFieldId?: string;
  batchIdFieldId?: string;
}

export const LaunchWriteBackFieldIdsSchema = z.object({
  instanceCodeFieldId: nonEmptyString.optional(),
  statusFieldId: nonEmptyString.optional(),
  submittedAtFieldId: nonEmptyString.optional(),
  batchIdFieldId: nonEmptyString.optional(),
});

export interface LaunchPolicy {
  batchMode: 'single-record' | 'multi-record';
  idempotency: 'batch-id';
  writeBackFieldIds?: LaunchWriteBackFieldIds;
}

export const LaunchPolicySchema = z.object({
  batchMode: z.enum(['single-record', 'multi-record']),
  idempotency: z.literal('batch-id'),
  writeBackFieldIds: LaunchWriteBackFieldIdsSchema.optional(),
});

export interface ApprovalConnection {
  approvalCode: string;
  approvalName: string;
  roles: ApprovalRole[];
  syncPolicy?: SyncPolicy;
  launchPolicy?: LaunchPolicy;
}

export const ApprovalConnectionSchema = z
  .object({
    approvalCode: nonEmptyString,
    approvalName: nonEmptyString,
    roles: z.array(ApprovalRoleSchema).min(1),
    syncPolicy: SyncPolicySchema.optional(),
    launchPolicy: LaunchPolicySchema.optional(),
  })
  .superRefine((connection: ApprovalConnection, context: z.RefinementCtx) => {
    if (new Set(connection.roles).size !== connection.roles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roles'],
        message: '审批流角色不能重复',
      });
    }
    if (connection.roles.includes('source') && !connection.syncPolicy) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['syncPolicy'],
        message: 'source 审批流必须配置 syncPolicy',
      });
    }
    if (connection.roles.includes('target') && !connection.launchPolicy) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['launchPolicy'],
        message: 'target 审批流必须配置 launchPolicy',
      });
    }
  });

export interface SyncedFieldBinding {
  sourceApprovalCode: string;
  sourceControlId: string;
  sourceControlName: string;
  sourceControlType: ApprovalControlType;
  baseTableId: string;
  baseFieldId: string;
  baseFieldName: string;
  baseFieldType: string;
}

export const SyncedFieldBindingSchema = z.object({
  sourceApprovalCode: nonEmptyString,
  sourceControlId: nonEmptyString,
  sourceControlName: z.string(),
  sourceControlType: ApprovalControlTypeSchema,
  baseTableId: nonEmptyString,
  baseFieldId: nonEmptyString,
  baseFieldName: z.string(),
  baseFieldType: nonEmptyString,
});

export interface SourceSystemFieldBindings {
  instanceCodeFieldId: string;
  statusFieldId: string;
  submittedAtFieldId: string;
  syncedAtFieldId: string;
}

export const SourceSystemFieldBindingsSchema = z.object({
  instanceCodeFieldId: nonEmptyString,
  statusFieldId: nonEmptyString,
  submittedAtFieldId: nonEmptyString,
  syncedAtFieldId: nonEmptyString,
});

export interface TargetWriteBackFieldBindings {
  instanceCodeFieldId: string;
  statusFieldId: string;
  submittedAtFieldId: string;
  batchIdFieldId: string;
}

export const TargetWriteBackFieldBindingsSchema = z.object({
  instanceCodeFieldId: nonEmptyString,
  statusFieldId: nonEmptyString,
  submittedAtFieldId: nonEmptyString,
  batchIdFieldId: nonEmptyString,
});

export interface SourceTableBinding {
  sourceApprovalCode: string;
  baseAppToken: string;
  baseTableId: string;
  baseTableName: string;
  systemFields: SourceSystemFieldBindings;
  baseUrl?: string;
}

export const SourceTableBindingSchema = z.object({
  sourceApprovalCode: nonEmptyString,
  baseAppToken: nonEmptyString,
  baseTableId: nonEmptyString,
  baseTableName: nonEmptyString,
  systemFields: SourceSystemFieldBindingsSchema,
  baseUrl: z.string().url().optional(),
});

export interface NewBaseSourceTableDestination {
  kind: 'new-base';
  baseName?: string;
  tableName?: string;
  folderToken?: string;
}

export interface ExistingBaseSourceTableDestination {
  kind: 'existing-base';
  baseAppToken: string;
  tableName?: string;
}

export type SourceTableDestination =
  | NewBaseSourceTableDestination
  | ExistingBaseSourceTableDestination;

export const SourceTableDestinationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new-base'),
    baseName: nonEmptyString.optional(),
    tableName: nonEmptyString.optional(),
    folderToken: nonEmptyString.optional(),
  }),
  z.object({
    kind: z.literal('existing-base'),
    baseAppToken: nonEmptyString,
    tableName: nonEmptyString.optional(),
  }),
]);

export interface SourceProvisioningRequest {
  approvalCode: string;
  destination: SourceTableDestination;
  baseUrl?: string;
}

export const SourceProvisioningRequestSchema = z.object({
  approvalCode: nonEmptyString,
  destination: SourceTableDestinationSchema,
  baseUrl: z.string().url().optional(),
});

export interface SourceProvisioningResult {
  sourceTableBinding: SourceTableBinding;
  syncedFieldBindings: SyncedFieldBinding[];
  connectorPlan: SourceConnectorPlan;
}

export interface SourceConnectorPlan {
  sourceApprovalCode: string;
  baseTableId: string;
  status: 'api-sync-enabled';
  mode: 'api';
  mapping: 'source-control-id-to-base-field-id';
  bindings: Array<{
    sourceControlId: string;
    baseFieldId: string;
  }>;
  systemFields: SourceSystemFieldBindings;
}

export const SourceConnectorPlanSchema = z.object({
  sourceApprovalCode: nonEmptyString,
  baseTableId: nonEmptyString,
  status: z.literal('api-sync-enabled'),
  mode: z.literal('api'),
  mapping: z.literal('source-control-id-to-base-field-id'),
  bindings: z.array(
    z.object({
      sourceControlId: nonEmptyString,
      baseFieldId: nonEmptyString,
    }),
  ),
  systemFields: SourceSystemFieldBindingsSchema,
});

export const SourceProvisioningResultSchema = z.object({
  sourceTableBinding: SourceTableBindingSchema,
  syncedFieldBindings: z.array(SyncedFieldBindingSchema),
  connectorPlan: SourceConnectorPlanSchema,
});

export interface TargetTableBinding {
  targetApprovalCode: string;
  baseAppToken: string;
  baseTableId: string;
  baseTableName: string;
  writeBackFields: TargetWriteBackFieldBindings;
  baseUrl?: string;
}

export const TargetTableBindingSchema = z.object({
  targetApprovalCode: nonEmptyString,
  baseAppToken: nonEmptyString,
  baseTableId: nonEmptyString,
  baseTableName: nonEmptyString,
  writeBackFields: TargetWriteBackFieldBindingsSchema,
  baseUrl: z.string().url().optional(),
});

export interface TargetTableDestination {
  kind: 'existing-base';
  baseUrl: string;
  tableName?: string;
}

export const TargetTableDestinationSchema = z.object({
  kind: z.literal('existing-base'),
  baseUrl: z.string().url(),
  tableName: nonEmptyString.optional(),
});

export interface TargetProvisioningRequest {
  approvalCode: string;
  destination: TargetTableDestination;
  fieldSources?: Record<string, TargetFieldSourceInput>;
}

export interface TargetProvisioningResult {
  targetTableBinding: TargetTableBinding;
  targetFieldBindings: TargetFieldBinding[];
  approvalSchemaFingerprint?: string;
}

export const TargetProvisioningResultSchema = z.object({
  targetTableBinding: TargetTableBindingSchema,
  targetFieldBindings: z.array(z.lazy(() => TargetFieldBindingSchema)),
  approvalSchemaFingerprint: nonEmptyString.optional(),
});

export interface TargetProvisioningResponse {
  targetTableBinding: TargetTableBindingResponse;
  targetFieldBindings: TargetFieldBinding[];
}

export interface TargetTableBindingResponse {
  targetApprovalCode: string;
  baseTableId: string;
  baseTableName: string;
  writeBackFields: TargetWriteBackFieldBindings;
  baseUrl?: string;
}

export const TargetTableBindingResponseSchema = z.object({
  targetApprovalCode: nonEmptyString,
  baseTableId: nonEmptyString,
  baseTableName: nonEmptyString,
  writeBackFields: TargetWriteBackFieldBindingsSchema,
  baseUrl: z.string().url().optional(),
});

export interface SourceProvisioningResponse {
  sourceTableBinding: {
    sourceApprovalCode: string;
    baseTableId: string;
    baseTableName: string;
    baseUrl?: string;
  };
  syncedFieldBindings: SyncedFieldBinding[];
  connectorPlan: SourceConnectorPlan;
}

export interface SourceSyncRequest {
  baseUrl: string;
  approvalCode: string;
}

export const SourceSyncRequestSchema = z.object({
  baseUrl: z.string().url(),
  approvalCode: nonEmptyString,
});

export interface SourceSyncResponse {
  sourceApprovalCode: string;
  syncedCount: number;
  skippedCount: number;
  syncState: SourceSyncState;
}

export const SourceSyncResponseSchema = z.object({
  sourceApprovalCode: nonEmptyString,
  syncedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  syncState: SourceSyncStateSchema,
});

const TargetFieldAtomicSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('base-field'),
    baseTableId: nonEmptyString,
    baseFieldId: nonEmptyString,
  }),
  z.object({
    kind: z.literal('manual'),
    inputKey: nonEmptyString,
    inputType: z.enum(['text', 'number', 'amount', 'date-time', 'attachment']),
  }),
  z.object({
    kind: z.literal('fixed-value'),
    value: z.unknown(),
  }),
  z.object({ kind: z.literal('current-operator') }),
  z.object({ kind: z.literal('current-time') }),
]);

export const TargetCalculationOperationSchema = z.enum([
  'sum',
  'average',
  'min',
  'max',
  'add',
  'subtract',
  'multiply',
  'divide',
]);
export type TargetCalculationOperation = z.infer<typeof TargetCalculationOperationSchema>;

const TargetCalculationSchema = z.object({
  kind: z.literal('calculation'),
  operation: TargetCalculationOperationSchema,
  operands: z.array(TargetFieldAtomicSourceSchema).min(2).max(20),
  scale: z.number().int().min(0).max(6).default(2),
  rounding: z.enum(['half-up', 'down', 'up']).default('half-up'),
});

const TargetTemplatePartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string() }),
  z.object({ kind: z.literal('source'), source: TargetFieldAtomicSourceSchema }),
]);

const TargetTemplateSchema = z.object({
  kind: z.literal('template'),
  parts: z.array(TargetTemplatePartSchema).min(1).max(40),
});

const TargetAttachmentMergeSchema = z.object({
  kind: z.literal('attachment-merge'),
  sources: z.array(TargetFieldAtomicSourceSchema).min(1).max(2),
});

export const TargetFieldSourceSchema = z.union([
  TargetFieldAtomicSourceSchema,
  TargetTemplateSchema,
  TargetCalculationSchema,
  TargetAttachmentMergeSchema,
]);

export type TargetFieldAtomicSource =
  | { kind: 'base-field'; baseTableId: string; baseFieldId: string }
  | { kind: 'manual'; inputKey: string; inputType: 'text' | 'number' | 'amount' | 'date-time' | 'attachment' }
  | { kind: 'fixed-value'; value: unknown }
  | { kind: 'current-operator' }
  | { kind: 'current-time' };

export type TargetFieldSource =
  | TargetFieldAtomicSource
  | { kind: 'template'; parts: Array<
      | { kind: 'literal'; value: string }
      | { kind: 'source'; source: TargetFieldAtomicSource }
    > }
  | {
      kind: 'calculation';
      operation: TargetCalculationOperation;
      operands: TargetFieldAtomicSource[];
      scale: number;
      rounding: 'half-up' | 'down' | 'up';
    }
  | { kind: 'attachment-merge'; sources: TargetFieldAtomicSource[] };

const TargetFieldAtomicSourceInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('base-field'),
    baseFieldId: nonEmptyString,
    baseTableId: nonEmptyString.optional(),
  }),
  z.object({
    kind: z.literal('manual'),
    inputKey: nonEmptyString,
    inputType: z.enum(['text', 'number', 'amount', 'date-time', 'attachment']),
  }),
  z.object({
    kind: z.literal('fixed-value'),
    value: z.unknown(),
  }),
  z.object({ kind: z.literal('current-operator') }),
  z.object({ kind: z.literal('current-time') }),
]);

const TargetCalculationInputSchema = z.object({
  kind: z.literal('calculation'),
  operation: TargetCalculationOperationSchema,
  operands: z.array(TargetFieldAtomicSourceInputSchema).min(2).max(20),
  scale: z.number().int().min(0).max(6).optional(),
  rounding: z.enum(['half-up', 'down', 'up']).optional(),
});

const TargetTemplatePartInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string() }),
  z.object({ kind: z.literal('source'), source: TargetFieldAtomicSourceInputSchema }),
]);

const TargetTemplateInputSchema = z.object({
  kind: z.literal('template'),
  parts: z.array(TargetTemplatePartInputSchema).min(1).max(40),
});

const TargetAttachmentMergeInputSchema = z.object({
  kind: z.literal('attachment-merge'),
  sources: z.array(TargetFieldAtomicSourceInputSchema).min(1).max(2),
});

export const TargetFieldSourceInputSchema = z.union([
  TargetFieldAtomicSourceInputSchema,
  TargetTemplateInputSchema,
  TargetCalculationInputSchema,
  TargetAttachmentMergeInputSchema,
]);

export type TargetFieldAtomicSourceInput =
  | { kind: 'base-field'; baseTableId?: string; baseFieldId: string }
  | { kind: 'manual'; inputKey: string; inputType: 'text' | 'number' | 'amount' | 'date-time' | 'attachment' }
  | { kind: 'fixed-value'; value: unknown }
  | { kind: 'current-operator' }
  | { kind: 'current-time' };

export type TargetFieldSourceInput =
  | TargetFieldAtomicSourceInput
  | { kind: 'template'; parts: Array<
      | { kind: 'literal'; value: string }
      | { kind: 'source'; source: TargetFieldAtomicSourceInput }
    > }
  | {
      kind: 'calculation';
      operation: TargetCalculationOperation;
      operands: TargetFieldAtomicSourceInput[];
      scale?: number;
      rounding?: 'half-up' | 'down' | 'up';
    }
  | { kind: 'attachment-merge'; sources: TargetFieldAtomicSourceInput[] };

export const TargetProvisioningRequestSchema = z.object({
  approvalCode: nonEmptyString,
  destination: TargetTableDestinationSchema,
  fieldSources: z.record(z.string(), TargetFieldSourceInputSchema).optional(),
});

export interface TargetFieldBinding {
  targetApprovalCode: string;
  targetControlId: string;
  targetControlName: string;
  targetControlType: ApprovalControlType;
  baseTableId: string;
  baseFieldId: string;
  baseFieldName: string;
  baseFieldType: string;
  source?: TargetFieldSource;
}

export const TargetFieldBindingSchema = z.object({
  targetApprovalCode: nonEmptyString,
  targetControlId: nonEmptyString,
  targetControlName: z.string(),
  targetControlType: ApprovalControlTypeSchema,
  baseTableId: nonEmptyString,
  baseFieldId: nonEmptyString,
  baseFieldName: z.string(),
  baseFieldType: nonEmptyString,
  source: TargetFieldSourceSchema.optional(),
});

export interface TargetFieldMatchSuggestion {
  targetControlId: string;
  targetControlName: string;
  targetControlType: ApprovalControlType;
  baseFieldId?: string;
  baseFieldName?: string;
  baseFieldType?: number;
  score: number;
  reason: 'name-and-type' | 'name-only' | 'type-only' | 'no-match';
}

export const TargetFieldMatchSuggestionSchema = z.object({
  targetControlId: nonEmptyString,
  targetControlName: z.string(),
  targetControlType: ApprovalControlTypeSchema,
  baseFieldId: nonEmptyString.optional(),
  baseFieldName: z.string().optional(),
  baseFieldType: z.number().int().optional(),
  score: z.number().int().min(0).max(100),
  reason: z.enum(['name-and-type', 'name-only', 'type-only', 'no-match']),
});

export const BusinessModuleSchema = z.enum(['payment']);
export type BusinessModule = z.infer<typeof BusinessModuleSchema>;

export interface BasePluginPageConfig {
  title: string;
  visibleModules: BusinessModule[];
}

export const BasePluginPageConfigSchema = z.object({
  title: nonEmptyString,
  visibleModules: z.array(BusinessModuleSchema),
});

export interface BasePluginTargetConfiguration {
  targetTableBinding: TargetTableBindingResponse;
  targetFieldBindings: TargetFieldBinding[];
  approvalSchemaFingerprint?: string;
}

export interface BasePluginSourceConfiguration {
  sourceTableBinding: SourceTableBinding;
  syncedFieldBindings: SyncedFieldBinding[];
  syncPolicy: SyncPolicy;
  syncState?: SourceSyncState;
}

export const BasePluginSourceConfigurationSchema = z.object({
  sourceTableBinding: SourceTableBindingSchema,
  syncedFieldBindings: z.array(SyncedFieldBindingSchema),
  syncPolicy: SyncPolicySchema,
  syncState: SourceSyncStateSchema.optional(),
});

export const BasePluginTargetConfigurationSchema = z.object({
  targetTableBinding: TargetTableBindingResponseSchema,
  targetFieldBindings: z.array(TargetFieldBindingSchema),
  approvalSchemaFingerprint: nonEmptyString.optional(),
});

export interface BasePluginProfileConfig {
  version: 1;
  page: BasePluginPageConfig;
  businessModules: BusinessModule[];
  targetApprovals: BasePluginTargetConfiguration[];
  sourceApprovals?: BasePluginSourceConfiguration[];
}

export const BasePluginProfileConfigSchema = z
  .object({
    version: z.literal(1),
    page: BasePluginPageConfigSchema,
    businessModules: z.array(BusinessModuleSchema),
    targetApprovals: z.array(BasePluginTargetConfigurationSchema),
    sourceApprovals: z.array(BasePluginSourceConfigurationSchema).default([]),
  })
  .superRefine(
    (config: BasePluginProfileConfig, context: z.RefinementCtx) => {
      const approvalCodes = new Set<string>();
      config.targetApprovals.forEach(
        (target: BasePluginTargetConfiguration, index: number) => {
          const code = target.targetTableBinding.targetApprovalCode;
          if (approvalCodes.has(code)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['targetApprovals', index],
              message: '同一个 Base 不能重复配置同一目标审批流',
            });
          }
          approvalCodes.add(code);
        },
      );
    },
  );

export interface BasePluginProfileSaveRequest {
  baseUrl: string;
  baseName?: string;
  config: BasePluginProfileConfig;
}

export const BasePluginProfileSaveRequestSchema = z.object({
  baseUrl: z.string().url(),
  baseName: nonEmptyString.optional(),
  config: BasePluginProfileConfigSchema,
});

export const TargetLaunchStatusSchema = z.enum([
  'preflight-failed',
  'upload-failed',
  'submit-failed',
  'submit-unknown',
  'partial-failure',
  'submitted',
  'writeback-pending',
  'completed',
]);
export type TargetLaunchStatus = z.infer<typeof TargetLaunchStatusSchema>;

export interface TargetLaunchRequest {
  baseUrl: string;
  approvalCode: string;
  recordIds: string[];
  manualInputs?: Record<string, unknown>;
  idempotencyKey: string;
}

export const TargetLaunchRequestSchema = z.object({
  baseUrl: z.string().url(),
  approvalCode: nonEmptyString,
  recordIds: z.array(nonEmptyString).min(1).max(100),
  manualInputs: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: nonEmptyString.max(64),
});

export interface TargetLaunchRecordResult {
  recordId: string;
  instanceCode?: string;
  approvalStatus?: string;
  submittedAt?: string;
  writebackComplete: boolean;
  error?: string;
}

export const TargetLaunchRecordResultSchema = z.object({
  recordId: nonEmptyString,
  instanceCode: nonEmptyString.optional(),
  approvalStatus: nonEmptyString.optional(),
  submittedAt: z.string().datetime().optional(),
  writebackComplete: z.boolean(),
  error: z.string().optional(),
});

export interface TargetLaunchResponse {
  batchId: string;
  idempotencyKey: string;
  status: TargetLaunchStatus;
  submitted: boolean;
  writebackComplete: boolean;
  results: TargetLaunchRecordResult[];
  message?: string;
}

export const TargetLaunchResponseSchema = z.object({
  batchId: nonEmptyString,
  idempotencyKey: nonEmptyString,
  status: TargetLaunchStatusSchema,
  submitted: z.boolean(),
  writebackComplete: z.boolean(),
  results: z.array(TargetLaunchRecordResultSchema),
  message: z.string().optional(),
});

export interface BasePluginProfileResponse {
  baseRef: string;
  baseName?: string;
  config: BasePluginProfileConfig;
}

export interface ApprovalPluginConfig {
  version: 1;
  connections: ApprovalConnection[];
  sourceTableBindings: SourceTableBinding[];
  sourceConnectorPlans: SourceConnectorPlan[];
  syncedFieldBindings: SyncedFieldBinding[];
  targetTableBindings: TargetTableBinding[];
  targetFieldBindings: TargetFieldBinding[];
}

export const ApprovalPluginConfigSchema = z
  .object({
    version: z.literal(1),
    connections: z.array(ApprovalConnectionSchema),
    sourceTableBindings: z.array(SourceTableBindingSchema),
    sourceConnectorPlans: z.array(SourceConnectorPlanSchema),
    syncedFieldBindings: z.array(SyncedFieldBindingSchema),
    targetTableBindings: z.array(TargetTableBindingSchema),
    targetFieldBindings: z.array(TargetFieldBindingSchema),
  })
  .superRefine((config: ApprovalPluginConfig, context: z.RefinementCtx) => {
    const sourceTableKeys = new Set<string>();
    config.sourceTableBindings.forEach(
      (binding: SourceTableBinding, index: number) => {
        if (sourceTableKeys.has(binding.sourceApprovalCode)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['sourceTableBindings', index],
            message: '同一来源审批流只能绑定一个多维表格',
          });
        }
        sourceTableKeys.add(binding.sourceApprovalCode);
      },
    );

    const sourceKeys = new Set<string>();
    const connectorKeys = new Set<string>();
    config.sourceConnectorPlans.forEach(
      (plan: SourceConnectorPlan, index: number) => {
        if (connectorKeys.has(plan.sourceApprovalCode)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['sourceConnectorPlans', index],
            message: '同一来源审批流只能配置一个连接器交接计划',
          });
        }
        connectorKeys.add(plan.sourceApprovalCode);
      },
    );

    config.syncedFieldBindings.forEach(
      (binding: SyncedFieldBinding, index: number) => {
        const key = sourceFieldBindingKey(binding);
        if (sourceKeys.has(key)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['syncedFieldBindings', index],
            message: '同一来源审批控件只能绑定一个多维表格字段',
          });
        }
        sourceKeys.add(key);
      },
    );

    const targetKeys = new Set<string>();
    const targetTableKeys = new Set<string>();
    config.targetTableBindings.forEach(
      (binding: TargetTableBinding, index: number) => {
        if (targetTableKeys.has(binding.targetApprovalCode)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['targetTableBindings', index],
            message: '同一目标审批流只能绑定一个提审数据表',
          });
        }
        targetTableKeys.add(binding.targetApprovalCode);
      },
    );
    config.targetFieldBindings.forEach(
      (binding: TargetFieldBinding, index: number) => {
        const key = targetFieldBindingKey(binding);
        if (targetKeys.has(key)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['targetFieldBindings', index],
            message: '同一目标审批控件只能配置一个数据来源',
          });
        }
        targetKeys.add(key);
      },
    );
  });

export function mergeSourceProvisioningResult(
  config: ApprovalPluginConfig,
  result: SourceProvisioningResult,
): ApprovalPluginConfig {
  const sourceApprovalCode = result.sourceTableBinding.sourceApprovalCode;
  const nextConfig: ApprovalPluginConfig = {
    ...config,
    sourceTableBindings: [
      ...config.sourceTableBindings.filter(
        (binding: SourceTableBinding) =>
          binding.sourceApprovalCode !== sourceApprovalCode,
      ),
      result.sourceTableBinding,
    ],
    syncedFieldBindings: [
      ...config.syncedFieldBindings.filter(
        (binding: SyncedFieldBinding) =>
          binding.sourceApprovalCode !== sourceApprovalCode,
      ),
      ...result.syncedFieldBindings,
    ],
    sourceConnectorPlans: [
      ...config.sourceConnectorPlans.filter(
        (plan: SourceConnectorPlan) =>
          plan.sourceApprovalCode !== sourceApprovalCode,
      ),
      result.connectorPlan,
    ],
  };
  return validateApprovalPluginConfig(nextConfig);
}

export function mergeTargetProvisioningResult(
  config: ApprovalPluginConfig,
  result: TargetProvisioningResult,
): ApprovalPluginConfig {
  const targetApprovalCode = result.targetTableBinding.targetApprovalCode;
  const nextConfig: ApprovalPluginConfig = {
    ...config,
    targetTableBindings: [
      ...config.targetTableBindings.filter(
        (binding: TargetTableBinding) =>
          binding.targetApprovalCode !== targetApprovalCode,
      ),
      result.targetTableBinding,
    ],
    targetFieldBindings: [
      ...config.targetFieldBindings.filter(
        (binding: TargetFieldBinding) =>
          binding.targetApprovalCode !== targetApprovalCode,
      ),
      ...result.targetFieldBindings,
    ],
  };
  return validateApprovalPluginConfig(nextConfig);
}

export function validateApprovalPluginConfig(
  input: unknown,
): ApprovalPluginConfig {
  const parsed: unknown = ApprovalPluginConfigSchema.parse(input);
  return parsed as ApprovalPluginConfig;
}

export function sourceFieldBindingKey(
  binding: Pick<SyncedFieldBinding, 'sourceApprovalCode' | 'sourceControlId'>,
): string {
  return `${binding.sourceApprovalCode}:${binding.sourceControlId}`;
}

export function targetFieldBindingKey(
  binding: Pick<TargetFieldBinding, 'targetApprovalCode' | 'targetControlId'>,
): string {
  return `${binding.targetApprovalCode}:${binding.targetControlId}`;
}

export function createSyncedFieldBinding(
  input: SyncedFieldBinding,
): SyncedFieldBinding {
  const parsed: unknown = SyncedFieldBindingSchema.parse(input);
  return parsed as SyncedFieldBinding;
}

export function findSyncedFieldBinding(
  bindings: SyncedFieldBinding[],
  sourceApprovalCode: string,
  sourceControlId: string,
): SyncedFieldBinding | undefined {
  return bindings.find(
    (binding: SyncedFieldBinding) =>
      sourceFieldBindingKey(binding) ===
      `${sourceApprovalCode}:${sourceControlId}`,
  );
}

function normalizedLabel(value: string): string {
  return value.trim().replace(/\s+/gu, '').toLowerCase();
}

export function findExactTargetAutoMatch(
  targetControl: Pick<ApprovalControl, 'name' | 'type'>,
  bindings: SyncedFieldBinding[],
): SyncedFieldBinding | undefined {
  const name = normalizedLabel(targetControl.name);
  const matches = bindings.filter(
    (binding: SyncedFieldBinding) =>
      normalizedLabel(binding.baseFieldName) === name &&
      binding.baseFieldType === targetControl.type,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
