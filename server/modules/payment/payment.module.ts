import { Module } from '@nestjs/common';
import { PaymentConfig } from './payment.config';
import { FeishuService } from './feishu.service';
import { ApprovalSchemaService } from './approval-schema.service';
import { ApprovalSubmissionService } from './approval-submission.service';
import { BitableRecordService } from './bitable-record.service';
import { BasePluginProfileService } from './base-plugin-profile.service';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { SourceProvisioningService } from './source-provisioning.service';
import { TargetProvisioningService } from './target-provisioning.service';
import { TargetLaunchService } from './target-launch.service';
import { TargetLaunchStateService } from './target-launch-state.service';
import { TargetFieldMatchingService } from './target-field-matching.service';
import { SourceSyncService } from './source-sync.service';
import { SourceSyncSchedulerService } from './source-sync-scheduler.service';

@Module({
  controllers: [PaymentController],
  providers: [
    PaymentConfig,
    FeishuService,
    ApprovalSchemaService,
    ApprovalSubmissionService,
    BitableRecordService,
    BasePluginProfileService,
    SourceProvisioningService,
    TargetProvisioningService,
    TargetLaunchService,
    TargetLaunchStateService,
    TargetFieldMatchingService,
    SourceSyncService,
    SourceSyncSchedulerService,
    PaymentService,
  ],
})
export class PaymentModule {}
