import { BadRequestException, Body, Controller, Get, Post, Put, Query, Req, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import type {
  ApprovalDefinitionSearchResponse,
  BasePluginProfileResponse,
  SourceProvisioningResponse,
  SourceSyncResponse,
  TargetFieldMatchSuggestion,
  TargetFieldSourceInput,
  TargetLaunchResponse,
  TargetProvisioningResponse,
} from '../../../shared/approval';
import {
  SourceProvisioningRequestSchema,
  SourceSyncRequestSchema,
  TargetProvisioningRequestSchema,
} from '../../../shared/approval';
import { ApprovalSchemaService } from './approval-schema.service';
import { ApprovalSubmissionService } from './approval-submission.service';
import { BasePluginProfileService } from './base-plugin-profile.service';
import { baseReferenceFromUrl, extractBaseToken } from './base-reference';
import { BitableRecordService } from './bitable-record.service';
import { FeishuService } from './feishu.service';
import {
  isSourceProvisioningValidationError,
  SourceProvisioningService,
} from './source-provisioning.service';
import { SourceSyncService } from './source-sync.service';
import { TargetFieldMatchingService } from './target-field-matching.service';
import { TargetLaunchService } from './target-launch.service';
import {
  isTargetProvisioningValidationError,
  TargetProvisioningService,
} from './target-provisioning.service';

@Controller('api')
export class ApprovalController {
  constructor(
    private readonly approvalSchemas: ApprovalSchemaService,
    private readonly approvalSubmission: ApprovalSubmissionService,
    private readonly basePluginProfiles: BasePluginProfileService,
    private readonly bitableRecords: BitableRecordService,
    private readonly feishu: FeishuService,
    private readonly sourceProvisioning: SourceProvisioningService,
    private readonly sourceSync: SourceSyncService,
    private readonly targetFieldMatching: TargetFieldMatchingService,
    private readonly targetLaunch: TargetLaunchService,
    private readonly targetProvisioning: TargetProvisioningService,
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

  @Get('approvals/schema')
  @NeedLogin()
  async approvalSchema(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('approvalCode') approvalCode?: string,
  ) {
    const normalizedCode = approvalCode?.trim();
    if (!normalizedCode) throw new BadRequestException('approvalCode 不能为空');
    const token = await this.feishu.userToken(req, res);
    return this.approvalSchemas.readApprovalSchema(token, normalizedCode);
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
    if (!normalizedKeyword) throw new BadRequestException('keyword 不能为空');
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
  async getPluginProfile(@Req() req: Request, @Query('baseUrl') baseUrl?: string): Promise<BasePluginProfileResponse | null> {
    const tenantId = this.requiredTenantId(req);
    const normalizedBaseUrl = baseUrl?.trim();
    if (!normalizedBaseUrl) throw new BadRequestException('baseUrl 不能为空');
    return this.basePluginProfiles.get(tenantId, normalizedBaseUrl);
  }

  @Put('plugin-profile')
  @NeedLogin()
  async savePluginProfile(@Req() req: Request, @Body() body: unknown): Promise<BasePluginProfileResponse> {
    const { tenantId, userId } = this.requiredUserContext(req);
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
      const { tenantId, userId } = this.requiredUserContext(req);
      const request = SourceProvisioningRequestSchema.safeParse(body);
      if (!request.success) throw new BadRequestException('同步审批流配置格式不正确');
      const baseUrl = request.data.baseUrl || result.sourceTableBinding.baseUrl;
      if (!baseUrl) throw new BadRequestException('Source 配置缺少 Base 链接，无法保存同步配置');
      await this.basePluginProfiles.mergeSourceProvisioning(tenantId, userId, baseUrl, result);
      return {
        sourceTableBinding: {
          sourceApprovalCode: result.sourceTableBinding.sourceApprovalCode,
          baseTableId: result.sourceTableBinding.baseTableId,
          baseTableName: result.sourceTableBinding.baseTableName,
          ...(result.sourceTableBinding.baseUrl ? { baseUrl: result.sourceTableBinding.baseUrl } : {}),
        },
        syncedFieldBindings: result.syncedFieldBindings,
        connectorPlan: result.connectorPlan,
      };
    } catch (error: unknown) {
      if (isSourceProvisioningValidationError(error)) {
        throw new BadRequestException('同步审批流配置格式不正确');
      }
      throw error;
    }
  }

  @Post('approvals/source/sync')
  @NeedLogin()
  async syncSource(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown): Promise<SourceSyncResponse> {
    const request = SourceSyncRequestSchema.safeParse(body);
    if (!request.success) throw new BadRequestException('审批实例同步参数格式不正确');
    const { tenantId, userId } = this.requiredUserContext(req);
    const token = await this.feishu.userToken(req, res);
    const source = await this.basePluginProfiles.findSource(
      tenantId,
      request.data.baseUrl,
      request.data.approvalCode,
    );
    if (!source) throw new BadRequestException('该多维表格尚未配置同步审批流');
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
    const fields = await this.bitableRecords.listFields(token, extractBaseToken(baseUrl), tableId.trim());
    return this.targetFieldMatching.suggest(schema.controls, fields);
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
      const tenantId = this.requiredTenantId(req);
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
          const { userId } = this.requiredUserContext(req);
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
      const result = await this.targetProvisioning.provision(token, body);
      const { userId } = this.requiredUserContext(req);
      if (!result.targetTableBinding.baseUrl) throw new BadRequestException('无法保存 Base 插件配置');
      await this.basePluginProfiles.mergeTargetProvisioning(
        tenantId,
        userId,
        result.targetTableBinding.baseUrl,
        result,
      );
      return {
        targetTableBinding: {
          targetApprovalCode: result.targetTableBinding.targetApprovalCode,
          baseTableId: result.targetTableBinding.baseTableId,
          baseTableName: result.targetTableBinding.baseTableName,
          writeBackFields: result.targetTableBinding.writeBackFields,
        },
        targetFieldBindings: result.targetFieldBindings,
      };
    } catch (error: unknown) {
      if (isTargetProvisioningValidationError(error)) {
        throw new BadRequestException('提审审批流配置格式不正确');
      }
      throw error;
    }
  }

  @Post('approvals/target/launch')
  @NeedLogin()
  @UseInterceptors(AnyFilesInterceptor({ limits: { files: 50, fileSize: 50 * 1024 * 1024 } }))
  async launchTarget(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { payload?: string },
    @UploadedFiles() files: Array<{ fieldname: string; originalname: string; mimetype: string; size: number; buffer: Buffer }> = [],
  ): Promise<TargetLaunchResponse> {
    let payload: unknown;
    try {
      payload = JSON.parse(body.payload || '{}') as unknown;
    } catch {
      throw new BadRequestException('提审审批提交参数格式不正确');
    }
    const { tenantId, userId } = this.requiredUserContext(req);
    const token = await this.feishu.userToken(req, res);
    return this.targetLaunch.launch(token, tenantId, userId, payload, files);
  }

  @Post('approvals/upload-file')
  @NeedLogin()
  @UseInterceptors(AnyFilesInterceptor({ limits: { files: 50, fileSize: 50 * 1024 * 1024 } }))
  async uploadApprovalFile(
    @UploadedFiles() files: Array<{ fieldname: string; originalname: string; mimetype: string; buffer: Buffer }> = [],
  ): Promise<{ items: Array<{ inputKey: string; fileCode: string }> }> {
    if (!files.length) throw new BadRequestException('请选择要上传的附件');
    const items = [];
    for (const file of files) {
      const fileCode = await this.approvalSubmission.uploadFile(
        file.buffer,
        file.originalname,
        file.mimetype,
      );
      items.push({ inputKey: file.fieldname.replace(/^manualInput:/, ''), fileCode });
    }
    return { items };
  }

  private requiredTenantId(req: Request): string {
    const tenantId = String(req.userContext?.tenantId || '');
    if (!tenantId) throw new BadRequestException('当前用户缺少租户标识');
    return tenantId;
  }

  private requiredUserContext(req: Request): { tenantId: string; userId: string } {
    const tenantId = String(req.userContext?.tenantId || '');
    const userId = String(req.userContext?.userId || '');
    if (!tenantId || !userId) throw new BadRequestException('当前用户身份信息不完整');
    return { tenantId, userId };
  }
}
