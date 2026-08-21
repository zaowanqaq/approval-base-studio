/** auto generated, do not edit */
import { pgTable, pgPolicy, uuid, varchar, text, jsonb, customType, index, uniqueIndex } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const userProfile = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'user_profile';
  },
  toDriver(value: string) {
    return sql`ROW(${value})::user_profile`;
  },
  fromDriver(value: string) {
    const [userId] = value.slice(1, -1).split(',');
    return userId.trim();
  },
});

export type FileAttachment = {
  bucket_id: string;
  file_path: string;
};

export const fileAttachment = customType<{
  data: FileAttachment;
  driverData: string;
}>({
  dataType() {
    return 'file_attachment';
  },
  toDriver(value: FileAttachment) {
    return sql`ROW(${value.bucket_id},${value.file_path})::file_attachment`;
  },
  fromDriver(value: string): FileAttachment {
    const [bucketId, filePath] = value.slice(1, -1).split(',');
    return { bucket_id: bucketId.trim(), file_path: filePath.trim() };
  },
});

export const customTimestamptz = customType<{
  data: Date;
  driverData: string;
  config: { precision?: number};
}>({
  dataType(config) {
    const precision = typeof config?.precision !== 'undefined'
      ? ` (${config.precision})`
      : '';
    return `timestamptz${precision}`;
  },
  toDriver(value: Date | string | number){
    if(value == null) return value as any;
    if (typeof value === 'number') {
      return new Date(value).toISOString();
    }
    if(typeof value === 'string') {
      return value;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    throw new Error('Invalid timestamp value');
  },
  fromDriver(value: string | Date): Date {
    if(value instanceof Date) return value;
    return new Date(value);
  },
});

export const basePluginProfiles = pgTable("base_plugin_profiles", {
  id: uuid().defaultRandom().notNull(),
  tenantId: text("tenant_id").notNull(),
  baseRef: varchar("base_ref", { length: 64 }).notNull(),
  baseName: varchar("base_name", { length: 255 }),
  config: jsonb("config").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: customTimestamptz("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: customTimestamptz("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
}, (table) => ({
  tenantBaseRef: uniqueIndex("base_plugin_profiles_tenant_base_ref_idx")
    .on(table.tenantId, table.baseRef),
}));

export const targetLaunchRecords = pgTable("target_launch_records", {
  id: uuid().defaultRandom().notNull(),
  tenantId: text("tenant_id").notNull(),
  userId: text("user_id").notNull(),
  baseRef: varchar("base_ref", { length: 64 }).notNull(),
  approvalCode: varchar("approval_code", { length: 255 }).notNull(),
  baseTableId: varchar("base_table_id", { length: 64 }).notNull(),
  batchId: varchar("batch_id", { length: 128 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  recordIds: jsonb("record_ids").notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  results: jsonb("results").notNull(),
  lastError: text("last_error"),
  createdAt: customTimestamptz("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: customTimestamptz("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
}, (table) => ({
  tenantIdempotencyKey: uniqueIndex("target_launch_records_tenant_idempotency_key_idx")
    .on(table.tenantId, table.idempotencyKey),
  baseApprovalIndex: index("target_launch_records_base_approval_idx")
    .on(table.tenantId, table.baseRef, table.approvalCode),
}));

/**
 * 以下是模板代码，仅作示例
 */
// export const record = pgTable("record", {
// 	id: uuid().defaultRandom().notNull(),
// 	title: varchar({ length: 255 }).notNull(),
// 	type: varchar({ length: 255 }).notNull(),
// 	creator: varchar({ length: 255 }).notNull(),
// 	speakDate: customTimestamptz("speakDate").notNull(),
// 	userProfile: userProfile("user_profile").notNull(),
// 	// System field: Creation time (auto-filled, do not modify)
// 	createdAt: customTimestamptz("_created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
// 	// System field: Creator (auto-filled, do not modify)
// 	createdBy: userProfile("_created_by"),
// 	// System field: Update time (auto-filled, do not modify)
// 	updatedAt: customTimestamptz("_updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
// 	// System field: Updater (auto-filled, do not modify)
// 	updatedBy: userProfile("_updated_by"),
// });
