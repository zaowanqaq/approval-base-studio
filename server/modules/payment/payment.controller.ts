import { BadRequestException, Body, Controller, Get, Post, Put, Query, Req, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import type {
  ApprovalDefinitionSearchResponse,
  BasePluginProfileResponse,
  SourceProvisioningResponse,
  TargetFieldMatchSuggestion,
  TargetLaunchResponse,
  TargetProvisioningResponse,
  TargetFieldSourceInput,
  SourceSyncResponse,
} from '@shared/approval';
import {
  SourceProvisioningRequestSchema,
  SourceSyncRequestSchema,
  TargetProvisioningRequestSchema,
} from '@shared/approval';
import { ApprovalSchemaService } from './approval-schema.service';
import { BasePluginProfileService } from './base-plugin-profile.service';
import { FeishuService } from './feishu.service';
import { PaymentService } from './payment.service';
import {
  isSourceProvisioningValidationError,
  SourceProvisioningService,
} from './source-provisioning.service';
import {
  isTargetProvisioningValidationError,
  TargetProvisioningService,
} from './target-provisioning.service';
import { TargetLaunchService } from './target-launch.service';
import { BitableRecordService } from './bitable-record.service';
import { TargetFieldMatchingService } from './target-field-matching.service';
import { SourceSyncService } from './source-sync.service';
import { extractBaseToken } from './base-reference';

@Controller('api')
export class PaymentController {
  constructor(
    private readonly feishu: FeishuService,
    private readonly payment: PaymentService,
    private readonly approvalSchemas: ApprovalSchemaService,
    private readonly basePluginProfiles: BasePluginProfileService,
    private readonly sourceProvisioning: SourceProvisioningService,
    private readonly targetProvisioning: TargetProvisioningService,
    private readonly targetLaunch: TargetLaunchService,
    private readonly bitableRecords: BitableRecordService,
    private readonly targetFieldMatching: TargetFieldMatchingService,
    private readonly sourceSync: SourceSyncService,
  ) {}

  @Get('health')
  health() {
    return { ok: true };
  }

  @Get('auth/me')
  @NeedLogin()
  async me(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = await this.feishu.userToken(req, res, false);
    if (!token) {
      return { name: req.userContext?.userName || '当前用户', openId: '', authMode: 'oauth', verified: false, authorized: false, authorizeUrl: this.feishu.createAuthorizeUrl(req) };
    }
    try {
      const user = await this.feishu.api<{ name?: string; open_id?: string }>('authen/v1/user_info', token);
      return { name: user.name || '飞书用户', openId: user.open_id || '', authMode: 'oauth', verified: true, authorized: true };
    } catch {
      return { name: req.userContext?.userName || '当前用户', openId: '', authMode: 'oauth', verified: false, authorized: false, authorizeUrl: this.feishu.createAuthorizeUrl(req) };
    }
  }

  @Post('oauth/callback')
  async callback(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: { code?: string; state?: string }) {
    const session = await this.feishu.completeOAuth(req, res, body.code || '', body.state || '');
    return { ok: true, session };
  }

  @Get('oauth/callback')
  oauthCallbackRedirect(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ): void {
    if (!code?.trim() || !state?.trim()) {
      throw new BadRequestException('飞书授权回调参数不完整');
    }
    res.redirect(this.feishu.createOAuthFrontendRedirect(req, code.trim(), state.trim()));
  }

  @Get('batches/preview')
  @NeedLogin()
  preview(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Query('tableId') tableId?: string) {
    return this.payment.preview(req, res, tableId);
  }

  @Get('closures/preview')
  @NeedLogin()
  closurePreview(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Query('tableId') tableId?: string) {
    return this.payment.closurePreview(req, res, tableId);
  }

  @Post('batches/submit')
  @NeedLogin()
  @UseInterceptors(AnyFilesInterceptor({
    limits: { files: 12, fileSize: 20 * 1024 * 1024 },
  }))
  submit(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { payload?: string },
    @UploadedFiles() files: Array<{ fieldname: string; originalname: string; mimetype: string; size: number; buffer: Buffer }> = [],
  ) {
    let payload: { reason?: string; paymentEntity?: string; expectedPaymentDate?: string; confirmed?: boolean; allowValidationErrors?: boolean };
    try {
      payload = JSON.parse(body.payload || '{}') as typeof payload;
    } catch {
      throw new BadRequestException('提交参数格式不正确');
    }
    return this.payment.submit(req, res, payload, files);
  }

  @Post('closures/submit')
  @NeedLogin()
  closureSubmit(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: {
      supplierSource?: string;
      confirmed?: boolean;
    },
  ) {
    return this.payment.closureSubmit(req, res, body);
  }

  @Post('approvals/sync')
  @NeedLogin()
  sync(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: { confirmed?: boolean }) {
    return this.payment.sync(req, res, body?.confirmed === true);
  }

  @Get('approvals/schema')
  @NeedLogin()
  async approvalSchema(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('approvalCode') approvalCode?: string,
  ) {
    const normalizedCode = approvalCode?.trim();
    if (!normalizedCode) {
      throw new BadRequestException('approvalCode 不能为空');
    }
    const token = await this.feishu.userToken(req, res);
    return this.approvalSchemas.readApprovalSchema(token, normalizedCode);
  }

  @Get('approvals/target/matches')
  @NeedLogin()
  async targetFieldMatches(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('approvalCode') approvalCode?: string,
    @Query('baseUrl') baseUrl?: string,
    @Query('tableId') tableId?: string,
  ): Promise<TargetFieldMatchSuggestion[]> {
    if (!approvalCode?.trim() || !baseUrl?.trim() || !tableId?.trim()) {
      throw new BadRequestException('approvalCode、baseUrl、tableId 不能为空');
    }
    const token = await this.feishu.userToken(req, res);
    const schema = await this.approvalSchemas.readApprovalSchema(token, approvalCode.trim());
    const fields = await this.bitableRecords.listFields(
      token,
      extractBaseToken(baseUrl),
      tableId.trim(),
    );
    return this.targetFieldMatching.suggest(schema.controls, fields);
  }

  @Get('approvals/launchable')
  @NeedLogin()
  async launchableApprovals(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('keyword') keyword?: string,
    @Query('pageToken') pageToken?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<ApprovalDefinitionSearchResponse> {
    const normalizedKeyword = keyword?.trim();
    if (!normalizedKeyword) {
      throw new BadRequestException('keyword 不能为空');
    }
    const parsedPageSize = pageSize ? Number(pageSize) : 50;
    if (!Number.isInteger(parsedPageSize) || parsedPageSize < 1 || parsedPageSize > 100) {
      throw new BadRequestException('pageSize 必须是 1 到 100 之间的整数');
    }
    const token = await this.feishu.userToken(req, res);
    return this.approvalSchemas.searchLaunchableApprovals(
      token,
      normalizedKeyword,
      pageToken?.trim() || undefined,
      parsedPageSize,
    );
  }

  @Get('plugin-profile')
  @NeedLogin()
  async getPluginProfile(
    @Req() req: Request,
    @Query('baseUrl') baseUrl?: string,
  ): Promise<BasePluginProfileResponse | null> {
    const tenantId = String(req.userContext?.tenantId || '');
    if (!tenantId) {
      throw new BadRequestException('当前用户缺少租户标识');
    }
    const normalizedBaseUrl = baseUrl?.trim();
    if (!normalizedBaseUrl) {
      throw new BadRequestException('baseUrl 不能为空');
    }
    return this.basePluginProfiles.get(tenantId, normalizedBaseUrl);
  }

  @Put('plugin-profile')
  @NeedLogin()
  async savePluginProfile(
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<BasePluginProfileResponse> {
    const tenantId = String(req.userContext?.tenantId || '');
    const userId = String(req.userContext?.userId || '');
    if (!tenantId || !userId) {
      throw new BadRequestException('当前用户身份信息不完整');
    }
    return this.basePluginProfiles.save(tenantId, userId, body);
  }

  @Post('approvals/source/provision')
  @NeedLogin()
  async provisionSource(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ): Promise<SourceProvisioningResponse> {
    const token = await this.feishu.userToken(req, res);
    try {
      const result = await this.sourceProvisioning.provision(token, body);
      const tenantId = String(req.userContext?.tenantId || '');
      const userId = String(req.userContext?.userId || '');
      if (!tenantId || !userId) {
        throw new BadRequestException('当前用户身份信息不完整');
      }
      const sourceRequest = SourceProvisioningRequestSchema.safeParse(body);
      if (!sourceRequest.success) {
        throw new BadRequestException('Source 审批流配置格式不正确');
      }
      const baseUrl = sourceRequest.data.baseUrl || result.sourceTableBinding.baseUrl;
      if (!baseUrl) {
        throw new BadRequestException('Source 配置缺少 Base 链接，无法保存同步配置');
      }
      await this.basePluginProfiles.mergeSourceProvisioning(
        tenantId,
        userId,
        baseUrl,
        result,
      );
      const response: SourceProvisioningResponse = {
        sourceTableBinding: {
          sourceApprovalCode: result.sourceTableBinding.sourceApprovalCode,
          baseTableId: result.sourceTableBinding.baseTableId,
          baseTableName: result.sourceTableBinding.baseTableName,
          ...(result.sourceTableBinding.baseUrl
            ? { baseUrl: result.sourceTableBinding.baseUrl }
            : {}),
        },
        syncedFieldBindings: result.syncedFieldBindings,
        connectorPlan: result.connectorPlan,
      };
      return response;
    } catch (error: unknown) {
      if (isSourceProvisioningValidationError(error)) {
        throw new BadRequestException('Source 审批流配置格式不正确');
      }
      throw error;
    }
  }

  @Post('approvals/source/sync')
  @NeedLogin()
  async syncSource(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ): Promise<SourceSyncResponse> {
    const request = SourceSyncRequestSchema.safeParse(body);
    if (!request.success) {
      throw new BadRequestException('Source 同步参数格式不正确');
    }
    const tenantId = String(req.userContext?.tenantId || '');
    const userId = String(req.userContext?.userId || '');
    if (!tenantId || !userId) {
      throw new BadRequestException('当前用户身份信息不完整');
    }
    const token = await this.feishu.userToken(req, res);
    const source = await this.basePluginProfiles.findSource(
      tenantId,
      request.data.baseUrl,
      request.data.approvalCode,
    );
    if (!source) {
      throw new BadRequestException('该 Base 尚未配置 Source 审批流');
    }
    const result = await this.sourceSync.sync(token, source);
    await this.basePluginProfiles.updateSourceSyncState(
      tenantId,
      userId,
      request.data.baseUrl,
      request.data.approvalCode,
      result.syncState,
    );
    return result;
  }

  @Post('approvals/target/provision')
  @NeedLogin()
  async provisionTarget(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ): Promise<TargetProvisioningResponse> {
    const token = await this.feishu.userToken(req, res);
    try {
      const tenantId = String(req.userContext?.tenantId || '');
      if (tenantId) {
        const request = TargetProvisioningRequestSchema.safeParse(body);
        if (request.success) {
          const existing = await this.basePluginProfiles.findTarget(
            tenantId,
            request.data.destination.baseUrl,
            request.data.approvalCode,
          );
          if (existing) {
            const updated = await this.targetProvisioning.updateFieldSources(
              token,
              request.data.destination.baseUrl,
              {
                targetTableBinding: existing.targetTableBinding,
                targetFieldBindings: existing.targetFieldBindings,
              },
              (request.data.fieldSources || {}) as Record<string, TargetFieldSourceInput>,
            );
            const userId = String(req.userContext?.userId || '');
            if (!userId) throw new BadRequestException('当前用户身份信息不完整');
            await this.basePluginProfiles.mergeTargetProvisioning(
              tenantId,
              userId,
              request.data.destination.baseUrl,
              updated,
            );
            return {
              targetTableBinding: existing.targetTableBinding,
              targetFieldBindings: updated.targetFieldBindings,
            };
          }
        }
      }
      const result = await this.targetProvisioning.provision(token, body);
      const userId = String(req.userContext?.userId || '');
      if (!tenantId || !userId || !result.targetTableBinding.baseUrl) {
        throw new BadRequestException('无法保存 Base 插件配置');
      }
      await this.basePluginProfiles.mergeTargetProvisioning(
        tenantId,
        userId,
        result.targetTableBinding.baseUrl,
        result,
      );
      const response: TargetProvisioningResponse = {
        targetTableBinding: {
          targetApprovalCode: result.targetTableBinding.targetApprovalCode,
          baseTableId: result.targetTableBinding.baseTableId,
          baseTableName: result.targetTableBinding.baseTableName,
          writeBackFields: result.targetTableBinding.writeBackFields,
        },
        targetFieldBindings: result.targetFieldBindings,
      };
      return response;
    } catch (error: unknown) {
      if (isTargetProvisioningValidationError(error)) {
        throw new BadRequestException('Target 审批流配置格式不正确');
      }
      throw error;
    }
  }

  @Post('approvals/target/launch')
  @NeedLogin()
  @UseInterceptors(AnyFilesInterceptor({
    limits: { files: 50, fileSize: 50 * 1024 * 1024 },
  }))
  async launchTarget(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { payload?: string },
    @UploadedFiles() files: Array<{
      fieldname: string;
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    }> = [],
  ): Promise<TargetLaunchResponse> {
    let payload: unknown;
    try {
      payload = JSON.parse(body.payload || '{}') as unknown;
    } catch {
      throw new BadRequestException('Target 审批提交参数格式不正确');
    }
    const tenantId = String(req.userContext?.tenantId || '');
    const userId = String(req.userContext?.userId || '');
    if (!tenantId || !userId) {
      throw new BadRequestException('当前用户身份信息不完整');
    }
    const token = await this.feishu.userToken(req, res);
    return this.targetLaunch.launch(token, tenantId, userId, payload, files);
  }
}
