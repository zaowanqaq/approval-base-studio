import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  TargetLaunchRecordResultSchema,
  TargetLaunchStatusSchema,
} from '../../../shared/approval';
import type {
  TargetLaunchRecordResult,
  TargetLaunchStatus,
} from '../../../shared/approval';
import { targetLaunchRecords } from '../../database/schema';

export type TargetLaunchStateRow = typeof targetLaunchRecords.$inferSelect;

export type TargetLaunchClaim = {
  created: boolean;
  row: TargetLaunchStateRow;
};

@Injectable()
export class TargetLaunchStateService {
  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
  ) {}

  async claim(input: {
    tenantId: string;
    userId: string;
    baseRef: string;
    approvalCode: string;
    baseTableId: string;
    batchId: string;
    idempotencyKey: string;
    recordIds: string[];
  }): Promise<TargetLaunchClaim> {
    const now = new Date();
    const values = {
      tenantId: input.tenantId,
      userId: input.userId,
      baseRef: input.baseRef,
      approvalCode: input.approvalCode,
      baseTableId: input.baseTableId,
      batchId: input.batchId,
      idempotencyKey: input.idempotencyKey,
      recordIds: input.recordIds,
      status: 'preflight-failed' as const,
      results: [],
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await this.db
      .insert(targetLaunchRecords)
      .values(values)
      .onConflictDoNothing({
        target: [targetLaunchRecords.tenantId, targetLaunchRecords.idempotencyKey],
      })
      .returning();
    if (inserted[0]) return { created: true, row: inserted[0] };

    const existing = await this.findByIdempotencyKey(
      input.tenantId,
      input.idempotencyKey,
    );
    if (!existing) throw new Error('幂等键冲突后无法读取已有 Target 发起记录');
    return { created: false, row: existing };
  }

  async update(
    id: string,
    patch: {
      status: TargetLaunchStatus;
      results: TargetLaunchRecordResult[];
      lastError?: string | null;
    },
  ): Promise<TargetLaunchStateRow> {
    const status = TargetLaunchStatusSchema.parse(patch.status) as TargetLaunchStatus;
    const results = patch.results.map(
      (item) => TargetLaunchRecordResultSchema.parse(item) as TargetLaunchRecordResult,
    );
    const rows = await this.db
      .update(targetLaunchRecords)
      .set({
        status,
        results,
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        updatedAt: new Date(),
      })
      .where(eq(targetLaunchRecords.id, id))
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`Target 发起状态记录 ${id} 不存在`);
    return row;
  }

  async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<TargetLaunchStateRow | null> {
    const rows = await this.db
      .select()
      .from(targetLaunchRecords)
      .where(
        and(
          eq(targetLaunchRecords.tenantId, tenantId),
          eq(targetLaunchRecords.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] || null;
  }

  parseResults(row: TargetLaunchStateRow): TargetLaunchRecordResult[] {
    return (Array.isArray(row.results) ? row.results : []).map(
      (item) => TargetLaunchRecordResultSchema.parse(item) as TargetLaunchRecordResult,
    );
  }
}
