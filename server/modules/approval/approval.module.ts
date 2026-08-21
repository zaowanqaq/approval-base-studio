import { Module } from '@nestjs/common';
import { ApprovalSchemaService } from './approval-schema.service';
import { ApprovalSubmissionService } from './approval-submission.service';
import { ApprovalController } from './approval.controller';
import { BasePluginProfileService } from './base-plugin-profile.service';
import { BitableRecordService } from './bitable-record.service';
import { ApprovalConfig } from './feishu.service';
import { FeishuService } from './feishu.service';
import { SourceProvisioningService } from './source-provisioning.service';
import { SourceSyncSchedulerService } from './source-sync-scheduler.service';
import { SourceSyncService } from './source-sync.service';
import { TargetFieldMatchingService } from './target-field-matching.service';
import { TargetLaunchService } from './target-launch.service';
import { TargetLaunchStateService } from './target-launch-state.service';
import { TargetProvisioningService } from './target-provisioning.service';

@Module({
  controllers: [ApprovalController],
  providers: [
    ApprovalConfig,
    FeishuService,
    ApprovalSchemaService,
    ApprovalSubmissionService,
    BasePluginProfileService,
    BitableRecordService,
    SourceProvisioningService,
    SourceSyncService,
    SourceSyncSchedulerService,
    TargetFieldMatchingService,
    TargetLaunchService,
    TargetLaunchStateService,
    TargetProvisioningService,
  ],
})
export class ApprovalModule {}
