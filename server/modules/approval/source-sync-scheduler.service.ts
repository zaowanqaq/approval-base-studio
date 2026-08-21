import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BasePluginProfileService } from './base-plugin-profile.service';
import { FeishuService } from './feishu.service';
import { SourceSyncService } from './source-sync.service';

const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 10;

@Injectable()
export class SourceSyncSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly running = new Set<string>();
  private timer?: NodeJS.Timeout;
  private intervalMs = Math.max(
    MIN_INTERVAL_SECONDS,
    Number(process.env.SOURCE_SYNC_INTERVAL_SECONDS || DEFAULT_INTERVAL_SECONDS),
  ) * 1000;

  constructor(
    private readonly basePluginProfiles: BasePluginProfileService,
    private readonly feishu: FeishuService,
    private readonly sourceSync: SourceSyncService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.syncAll();
    }, this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async syncAll(): Promise<void> {
    const configurations = await this.basePluginProfiles.listSourceConfigurations();
    const configuredIntervals = configurations
      .map((item) => item.source.syncPolicy.intervalSeconds)
      .filter((value: number | undefined): value is number => typeof value === 'number');
    if (configuredIntervals.length) {
      this.intervalMs = Math.min(...configuredIntervals) * 1000;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = setInterval(() => {
          void this.syncAll();
        }, this.intervalMs);
        this.timer.unref();
      }
    }
    await Promise.all(configurations.map(async (item) => {
      const key = `${item.tenantId}:${item.baseRef}:${item.source.sourceTableBinding.sourceApprovalCode}`;
      if (this.running.has(key)) return;
      this.running.add(key);
      try {
        const token = await this.feishu.tenantAccessToken();
        const result = await this.sourceSync.sync(token, item.source);
        await this.basePluginProfiles.updateSourceSyncStateByRef(
          item.tenantId,
          item.baseRef,
          item.source.sourceTableBinding.sourceApprovalCode,
          result.syncState,
        );
      } catch (error) {
        const lastError = error instanceof Error ? error.message : String(error);
        await this.saveErrorState(item, lastError);
      } finally {
        this.running.delete(key);
      }
    }));
  }

  private async saveErrorState(
    item: Awaited<ReturnType<BasePluginProfileService['listSourceConfigurations']>>[number],
    lastError: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const previous = item.source.syncState;
    await this.basePluginProfiles.updateSourceSyncStateByRef(
      item.tenantId,
      item.baseRef,
      item.source.sourceTableBinding.sourceApprovalCode,
      {
        ...previous,
        lastSyncAt: now,
        lastStartTime: previous?.lastStartTime,
        lastEndTime: previous?.lastEndTime,
        lastSyncedCount: previous?.lastSyncedCount || 0,
        lastSkippedCount: previous?.lastSkippedCount || 0,
        lastError,
      },
    );
  }
}
