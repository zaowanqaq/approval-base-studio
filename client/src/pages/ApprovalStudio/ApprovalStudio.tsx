import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Layers3,
  LoaderCircle,
  Play,
  Save,
  Search,
  ShieldCheck,
  Table2,
} from 'lucide-react';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@client/src/components/ui/card';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { authApi, pluginProfileApi, type FeishuAuthStatus } from '@client/src/api';
import { extractBaseToken } from '@client/src/lib/base-reference';
import { resolveSelectedRecordContext } from '@client/src/lib/base-context';
import type {
  ApprovalSchema,
  ApprovalDefinitionSummary,
  BasePluginTargetConfiguration,
  BasePluginProfileConfig,
  BasePluginProfileResponse,
  SourceProvisioningResponse,
  TargetFieldAtomicSourceInput,
  TargetFieldBinding,
  TargetFieldSourceInput,
  TargetLaunchResponse,
  TargetProvisioningResponse,
} from '@shared/approval';
import { isComputedApprovalControl } from '@shared/approval';

function sourceInputsFromBindings(
  bindings: BasePluginTargetConfiguration['targetFieldBindings'],
): Record<string, TargetFieldSourceInput> {
  const entries = bindings.flatMap((binding) => {
    if (!binding.source) return [];
    return [[binding.targetControlId, binding.source] as const];
  });
  return Object.fromEntries(entries);
}

function profileTargets(profile: BasePluginProfileResponse | null): BasePluginTargetConfiguration[] {
  const targets = profile?.config?.targetApprovals;
  return Array.isArray(targets) ? targets : [];
}

function normalizedProfileConfig(profile: BasePluginProfileResponse | null): BasePluginProfileConfig {
  const config = profile?.config;
  return {
    version: 1,
    page: {
      title: config?.page?.title || '通用审批多维表格工作台',
      visibleModules: config?.page?.visibleModules || ['approvals'],
      sourceSyncIntervalSeconds: config?.page?.sourceSyncIntervalSeconds || 60,
    },
    businessModules: config?.businessModules || ['approvals'],
    targetApprovals: profileTargets(profile),
    sourceApprovals: config?.sourceApprovals || [],
  };
}

function approvalControlType(type: string): string {
  const key = type.trim().toLowerCase().replace(/[-_]/gu, '');
  const labels: Record<string, string> = {
    input: '文本',
    text: '文本',
    textarea: '多行文本',
    number: '数字',
    amount: '金额',
    date: '日期',
    datetime: '日期时间',
    radio: '单选',
    radiov2: '单选',
    checkbox: '复选',
    checkboxv2: '复选',
    contact: '人员',
    user: '人员',
    department: '部门',
    attachment: '附件',
    attachmentv2: '附件',
    image: '图片',
    imagev2: '图片',
  };
  return labels[key] || '自定义控件';
}

const PluginConfigPage: React.FC = () => {
  const [baseUrl, setBaseUrl] = useState<string>('');
  const [baseName, setBaseName] = useState<string>('');
  const [approvalCode, setApprovalCode] = useState<string>('');
  const [approvalKeyword, setApprovalKeyword] = useState<string>('审批');
  const [launchableApprovals, setLaunchableApprovals] = useState<ApprovalDefinitionSummary[]>([]);
  const [launchablePageToken, setLaunchablePageToken] = useState<string | undefined>(undefined);
  const [tableName, setTableName] = useState<string>('');
  const [pageTitle, setPageTitle] = useState<string>('通用审批多维表格工作台');
  const [sourceSyncIntervalSeconds, setSourceSyncIntervalSeconds] = useState<number>(60);
  const [schema, setSchema] = useState<ApprovalSchema | null>(null);
  const [profile, setProfile] = useState<BasePluginProfileResponse | null>(null);
  const [targetResult, setTargetResult] = useState<TargetProvisioningResponse | null>(null);
  const [sourceResult, setSourceResult] = useState<SourceProvisioningResponse | null>(null);
  const [sourceTableName, setSourceTableName] = useState<string>('');
  const [fieldSources, setFieldSources] = useState<Record<string, TargetFieldSourceInput>>({});
  const [launchApprovalCode, setLaunchApprovalCode] = useState<string>('');
  const [launchSchema, setLaunchSchema] = useState<ApprovalSchema | null>(null);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [manualInputs, setManualInputs] = useState<Record<string, unknown>>({});
  const [manualFiles, setManualFiles] = useState<Record<string, File[]>>({});
  const [launchIdempotencyKey, setLaunchIdempotencyKey] = useState<string>('');
  const [launchResult, setLaunchResult] = useState<TargetLaunchResponse | null>(null);
  const [working, setWorking] = useState<boolean>(false);
  const [message, setMessage] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [authStatus, setAuthStatus] = useState<FeishuAuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string>('');

  async function refreshAuthStatus(): Promise<void> {
    setAuthLoading(true);
    setAuthError('');
    try {
      setAuthStatus(await authApi.me());
    } catch (cause: unknown) {
      setAuthError(cause instanceof Error ? cause.message : '读取飞书身份失败');
    } finally {
      setAuthLoading(false);
    }
  }

  useEffect(() => {
    void refreshAuthStatus();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) return;
    setAuthLoading(true);
    authApi.callback({ code, state })
      .then((result) => {
        if (result.session) window.localStorage.setItem('approval_feishu_session', result.session);
        window.history.replaceState({}, '', window.location.pathname);
        return refreshAuthStatus();
      })
      .catch((cause: unknown) => {
        setAuthError(cause instanceof Error ? cause.message : '飞书授权失败');
        setAuthLoading(false);
      });
  }, []);

  function configForUi(config: BasePluginProfileConfig): BasePluginProfileConfig {
    return {
      ...config,
      page: {
        ...config.page,
        title: pageTitle.trim() || '通用审批多维表格工作台',
        visibleModules: ['approvals'],
        sourceSyncIntervalSeconds,
      },
      businessModules: ['approvals'],
    };
  }

  function setFieldSource(controlId: string, source: TargetFieldSourceInput | undefined): void {
    setFieldSources((current: Record<string, TargetFieldSourceInput>) => {
      const next = { ...current };
      if (source) next[controlId] = source;
      else delete next[controlId];
      return next;
    });
  }

  function applyStoredTargetSources(
    nextProfile: BasePluginProfileResponse | null,
    targetApprovalCode?: string,
  ): void {
    const target = profileTargets(nextProfile).find(
      (item) => item.targetTableBinding.targetApprovalCode === targetApprovalCode,
    ) || profileTargets(nextProfile)[0];
    setFieldSources(sourceInputsFromBindings(target?.targetFieldBindings || []));
  }

  function sourceKind(controlId: string): TargetFieldSourceInput['kind'] | 'automatic' {
    return fieldSources[controlId]?.kind || 'automatic';
  }

  function manualSource(controlId: string): {
    kind: 'manual';
    inputKey: string;
    inputType: 'text' | 'number' | 'amount' | 'date-time' | 'attachment';
  } | undefined {
    const source = fieldSources[controlId];
    if (!source || source.kind !== 'manual' || !('inputKey' in source) || !('inputType' in source)) {
      return undefined;
    }
    return {
      kind: 'manual',
      inputKey: String(source.inputKey || ''),
      inputType: source.inputType || 'text',
    };
  }

  function fixedValueSource(controlId: string): { kind: 'fixed-value'; value: unknown } | undefined {
    const source = fieldSources[controlId];
    if (!source || source.kind !== 'fixed-value' || !('value' in source)) return undefined;
    return { kind: 'fixed-value', value: source.value };
  }

  function baseFieldSource(controlId: string): Extract<TargetFieldSourceInput, { kind: 'base-field' }> | undefined {
    const source = fieldSources[controlId];
    return source?.kind === 'base-field' ? source : undefined;
  }

  function templateSource(controlId: string): Extract<TargetFieldSourceInput, { kind: 'template' }> | undefined {
    const source = fieldSources[controlId];
    return source?.kind === 'template' ? source : undefined;
  }

  function calculationSource(controlId: string): Extract<TargetFieldSourceInput, { kind: 'calculation' }> | undefined {
    const source = fieldSources[controlId];
    return source?.kind === 'calculation' ? source : undefined;
  }

  function availableTargetFields(): TargetFieldBinding[] {
    if (targetResult && targetResult.targetTableBinding.targetApprovalCode === approvalCode.trim()) {
      return targetResult.targetFieldBindings;
    }
    return profileTargets(profile).find(
      (target) => target.targetTableBinding.targetApprovalCode === approvalCode.trim(),
    )?.targetFieldBindings || [];
  }

  function atomicInput(kind: string, inputKey: string): TargetFieldAtomicSourceInput {
    if (kind === 'fixed-value') return { kind: 'fixed-value', value: '' };
    if (kind === 'current-operator') return { kind: 'current-operator' };
    return { kind: 'manual', inputKey, inputType: 'text' };
  }

  async function loadProfile(): Promise<void> {
    if (!baseUrl.trim()) {
      setError('请先填写多维表格链接');
      return;
    }
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const nextProfile = await pluginProfileApi.get(baseUrl.trim());
      setProfile(nextProfile);
      if (nextProfile?.config) {
        setBaseName(nextProfile.baseName || '');
        setPageTitle(nextProfile.config.page?.title || '通用审批多维表格工作台');
        setSourceSyncIntervalSeconds(nextProfile.config.page?.sourceSyncIntervalSeconds || 60);
        setLaunchApprovalCode((current) => current || profileTargets(nextProfile)[0]?.targetTableBinding.targetApprovalCode || '');
        applyStoredTargetSources(nextProfile);
      }
      setMessage(nextProfile ? '已读取该多维表格的插件配置' : '该多维表格还没有插件配置。请先识别审批流并创建提审表。');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '读取多维表格配置失败');
    } finally {
      setWorking(false);
    }
  }

  async function readSchema(): Promise<void> {
    if (!approvalCode.trim()) {
      setError('请填写审批编号');
      return;
    }
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const nextSchema = await pluginProfileApi.readSchema(approvalCode.trim());
      setSchema(nextSchema);
      applyStoredTargetSources(profile, approvalCode.trim());
      setMessage(`已识别审批流：${nextSchema.approvalName}`);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '读取审批结构失败');
    } finally {
      setWorking(false);
    }
  }

  async function searchLaunchableApprovals(): Promise<void> {
    if (!approvalKeyword.trim()) {
      setError('请填写审批流搜索关键词');
      return;
    }
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const result = await pluginProfileApi.searchLaunchable(approvalKeyword.trim());
      setLaunchableApprovals(result.items);
      setLaunchablePageToken(result.pageToken);
      setMessage(result.items.length ? `找到 ${result.items.length} 个审批流候选` : '没有找到可发起的审批流');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '搜索可发起审批流失败');
    } finally {
      setWorking(false);
    }
  }

  async function loadMoreLaunchableApprovals(): Promise<void> {
    if (!launchablePageToken) return;
    setWorking(true);
    setError('');
    try {
      const result = await pluginProfileApi.searchLaunchable(
        approvalKeyword.trim(),
        launchablePageToken,
      );
      setLaunchableApprovals((current: ApprovalDefinitionSummary[]) => [
        ...current,
        ...result.items,
      ]);
      setLaunchablePageToken(result.pageToken);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '读取更多审批流失败');
    } finally {
      setWorking(false);
    }
  }

  async function createTargetTable(): Promise<void> {
    if (!baseUrl.trim() || !approvalCode.trim()) {
      setError('请先填写多维表格链接和审批编号');
      return;
    }
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const result = await pluginProfileApi.provisionTarget({
        approvalCode: approvalCode.trim(),
        destination: {
          kind: 'existing-base',
          baseUrl: baseUrl.trim(),
          ...(tableName.trim() ? { tableName: tableName.trim() } : {}),
        },
        ...(Object.keys(fieldSources).length ? { fieldSources } : {}),
      });
      setTargetResult(result);
      setLaunchApprovalCode(approvalCode.trim());
      setFieldSources(sourceInputsFromBindings(result.targetFieldBindings));
      const nextProfile = await pluginProfileApi.get(baseUrl.trim());
      setProfile(nextProfile);
      setMessage(`已创建提审表：${result.targetTableBinding.baseTableName}`);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '创建提审表失败');
    } finally {
      setWorking(false);
    }
  }

  async function createSourceTable(): Promise<void> {
    if (!baseUrl.trim() || !approvalCode.trim()) {
      setError('请先填写多维表格链接和审批编号');
      return;
    }
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const result = await pluginProfileApi.provisionSource({
        approvalCode: approvalCode.trim(),
        destination: {
          kind: 'existing-base',
          baseAppToken: extractBaseToken(baseUrl.trim()),
          ...(sourceTableName.trim() ? { tableName: sourceTableName.trim() } : {}),
        },
        baseUrl: baseUrl.trim(),
      });
      setSourceResult(result);
      const nextProfile = await pluginProfileApi.get(baseUrl.trim());
      setProfile(nextProfile);
      setMessage(`已创建同步表：${result.sourceTableBinding.baseTableName}`);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '创建同步表失败');
    } finally {
      setWorking(false);
    }
  }

  async function syncSourceNow(): Promise<void> {
    if (!baseUrl.trim() || !approvalCode.trim()) {
      setError('请先填写多维表格链接和审批编号');
      return;
    }
    setWorking(true);
    setError('');
    try {
      const result = await pluginProfileApi.syncSource({
        baseUrl: baseUrl.trim(),
        approvalCode: approvalCode.trim(),
      });
      const state = result.syncState;
      setMessage(`同步完成：新增/更新 ${state.lastSyncedCount || 0} 条，跳过 ${state.lastSkippedCount || 0} 条`);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '同步审批实例失败');
    } finally {
      setWorking(false);
    }
  }

  async function saveProfile(): Promise<void> {
    if (!baseUrl.trim()) {
      setError('请先填写多维表格链接');
      return;
    }
    setWorking(true);
    setError('');
    setMessage('');
    try {
      let config = normalizedProfileConfig(profile);
      const configuredTarget = config.targetApprovals.find(
        (target) => target.targetTableBinding.targetApprovalCode === approvalCode.trim(),
      );
      if (configuredTarget && approvalCode.trim()) {
        await pluginProfileApi.provisionTarget({
          approvalCode: approvalCode.trim(),
          destination: { kind: 'existing-base', baseUrl: baseUrl.trim() },
          fieldSources,
        });
        const refreshed = await pluginProfileApi.get(baseUrl.trim());
        if (refreshed) {
          config = refreshed.config;
          setProfile(refreshed);
        }
      }
      const saved = await pluginProfileApi.save({
        baseUrl: baseUrl.trim(),
        ...(baseName.trim() ? { baseName: baseName.trim() } : {}),
        config: configForUi(config),
      });
      setProfile(saved);
      setMessage('多维表格插件配置已保存');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '保存插件配置失败');
    } finally {
      setWorking(false);
    }
  }

  function launchManualSources(binding: BasePluginProfileResponse['config']['targetApprovals'][number]['targetFieldBindings'][number]): Array<{
    inputKey: string;
    inputType: 'text' | 'number' | 'amount' | 'date-time' | 'attachment';
  }> {
    const source = binding.source;
    if (!source) return [];
    if (source.kind === 'manual') return [{ inputKey: source.inputKey, inputType: source.inputType }];
    if (source.kind === 'template') {
      return source.parts.flatMap((part) => part.kind === 'source' && part.source.kind === 'manual'
        ? [{ inputKey: part.source.inputKey, inputType: part.source.inputType }]
        : []);
    }
    if (source.kind === 'calculation') {
      return source.operands.flatMap((operand) => operand.kind === 'manual'
        ? [{ inputKey: operand.inputKey, inputType: operand.inputType }]
        : []);
    }
    if (source.kind === 'attachment-merge') {
      return source.sources.flatMap((item) => item.kind === 'manual'
        ? [{ inputKey: item.inputKey, inputType: item.inputType }]
        : []);
    }
    return [];
  }

  const visibleSchemaControls = schema?.controls.filter(
    (control) => !isComputedApprovalControl(control),
  ) || [];
  const computedSchemaCount = schema?.controls.filter(isComputedApprovalControl).length || 0;

  async function loadLaunchSchema(): Promise<void> {
    if (!launchApprovalCode.trim()) {
      setError('请先选择已配置的目标审批流');
      return;
    }
    setWorking(true);
    setError('');
    try {
      const nextSchema = await pluginProfileApi.readSchema(launchApprovalCode.trim());
      setLaunchSchema(nextSchema);
      setMessage(`已读取发起表单：${nextSchema.approvalName}`);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '读取发起表单失败');
    } finally {
      setWorking(false);
    }
  }

  async function readSelectedRecords(): Promise<void> {
    const context = await resolveSelectedRecordContext();
    if (!context.embedded) {
      setError('当前页面不在飞书多维表格环境中，无法读取选中记录');
      return;
    }
    if (!context.recordIds.length) {
      setError('请先在当前 Table 中选择至少一条记录');
      return;
    }
    setSelectedRecordIds(context.recordIds);
    setLaunchIdempotencyKey('');
    setLaunchResult(null);
    setMessage(`已读取 ${context.recordIds.length} 条选中记录`);
  }

  async function launchTargetApproval(): Promise<void> {
    if (!baseUrl.trim() || !launchApprovalCode.trim()) {
      setError('请先填写多维表格链接并选择目标审批流');
      return;
    }
    if (!selectedRecordIds.length) {
      setError('请先读取当前 Table 的选中记录');
      return;
    }
    setWorking(true);
    setError('');
    try {
      const key = launchIdempotencyKey || (typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `target-${Date.now()}`);
      setLaunchIdempotencyKey(key);
      const result = await pluginProfileApi.launchTarget({
        baseUrl: baseUrl.trim(),
        approvalCode: launchApprovalCode.trim(),
        recordIds: selectedRecordIds,
        manualInputs,
        idempotencyKey: key,
      }, manualFiles);
      setLaunchResult(result);
      setMessage(result.message || `已发起 ${result.results.length} 条审批`);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '发起目标审批失败');
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-8 text-foreground md:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Layers3 className="size-4" /> 多维表格级插件配置
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">通用审批工作台配置</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            审批实例同步由插件自动完成。这里负责识别审批流程、创建数据表和保存当前多维表格的页面配置。
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" />飞书身份</CardTitle>
            <CardDescription>读取审批结构、搜索可发起流程和创建提审表需要当前用户完成飞书授权。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            {authLoading ? (
              <span className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取授权状态</span>
            ) : authStatus?.authorized ? (
              <Badge variant="secondary">已授权：{authStatus.name || '飞书用户'}</Badge>
            ) : (
              <Badge variant="outline">尚未授权</Badge>
            )}
            {!authLoading && !authStatus?.authorized && authStatus?.authorizeUrl && (
              <Button asChild type="button">
                <a href={authStatus.authorizeUrl} target="_blank" rel="opener"><ShieldCheck />授权飞书后继续</a>
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => void refreshAuthStatus()} disabled={authLoading}>
              {authLoading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}刷新身份
            </Button>
            {authError && <span className="text-sm text-destructive">{authError}</span>}
          </CardContent>
        </Card>

        {(error || message) && (
          <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${error ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-primary/30 bg-primary/5 text-primary'}`}>
            {error ? <AlertCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
            <span>{error || message}</span>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>1. 连接已有多维表格</CardTitle>
            <CardDescription>只填写飞书多维表格链接，不要填写访问令牌或密钥。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2 md:col-span-2">
              <Label htmlFor="base-url">多维表格链接</Label>
              <Input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://example.feishu.cn/base/..." />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="base-name">配置名称（可选）</Label>
              <Input id="base-name" value={baseName} onChange={(event) => setBaseName(event.target.value)} placeholder="例如：财务审批表格" />
            </div>
            <div className="flex items-end">
              <Button type="button" variant="outline" onClick={() => void loadProfile()} disabled={working}>
                {working ? <LoaderCircle className="animate-spin" /> : <Search />}读取配置
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. 识别目标审批流</CardTitle>
            <CardDescription>可按关键词搜索当前用户可发起的审批流，也可以直接填写审批编号。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2 md:grid-cols-[1fr_auto]">
              <div className="grid gap-2">
                <Label htmlFor="approval-keyword">审批流关键词</Label>
                <Input id="approval-keyword" value={approvalKeyword} onChange={(event) => setApprovalKeyword(event.target.value)} placeholder="例如：付款、结项、报销" />
              </div>
              <div className="flex items-end">
                <Button type="button" variant="outline" onClick={() => void searchLaunchableApprovals()} disabled={working}>
                  {working ? <LoaderCircle className="animate-spin" /> : <Search />}搜索可发起流程
                </Button>
              </div>
            </div>
            {launchableApprovals.length > 0 && (
              <div className="grid gap-2 rounded-lg border bg-muted/20 p-3">
                <span className="text-xs text-muted-foreground">选择一个原生审批流后，再读取审批结构：</span>
                <div className="grid gap-2 md:grid-cols-2">
                  {launchableApprovals.map((item: ApprovalDefinitionSummary) => (
                    <Button
                      key={item.approvalCode}
                      type="button"
                      variant={approvalCode === item.approvalCode ? 'secondary' : 'outline'}
                      className="h-auto justify-between whitespace-normal text-left"
                      disabled={item.isExternal}
                      onClick={() => {
                        setApprovalCode(item.approvalCode);
                        setSchema(null);
                        applyStoredTargetSources(profile, item.approvalCode);
                      }}
                    >
                      <span>
                        <strong className="block">{item.approvalName}</strong>
                        <small className="text-muted-foreground">{item.approvalCode}</small>
                      </span>
                      <Badge variant={item.isExternal ? 'outline' : 'secondary'}>
                        {item.isExternal ? '三方审批' : '原生审批'}
                      </Badge>
                    </Button>
                  ))}
                </div>
                {launchablePageToken && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => void loadMoreLaunchableApprovals()} disabled={working}>
                    加载更多
                  </Button>
                )}
              </div>
            )}
            <div className="grid gap-4 md:grid-cols-[1fr_auto]">
            <div className="grid gap-2">
              <Label htmlFor="approval-code">审批编号</Label>
              <Input id="approval-code" value={approvalCode} onChange={(event) => setApprovalCode(event.target.value)} placeholder="填写审批定义编号" />
            </div>
            <div className="flex items-end">
              <Button type="button" variant="outline" onClick={() => void readSchema()} disabled={working}>
                {working ? <LoaderCircle className="animate-spin" /> : <Search />}读取审批结构
              </Button>
            </div>
            </div>
            {schema && (
              <div className="rounded-lg border bg-muted/20 p-4 md:col-span-2">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <strong>{schema.approvalName}</strong>
                  <Badge variant="secondary">{visibleSchemaControls.length} 个可配置控件</Badge>
                  {computedSchemaCount > 0 && (
                    <Badge variant="outline">{computedSchemaCount} 个自动计算控件</Badge>
                  )}
                </div>
                {computedSchemaCount > 0 && (
                  <div className="mb-3 rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
                    自动计算控件由飞书审批在提交后计算，不会创建为提审表字段，也不会随审批发起提交；同步表会保存审批实例中的计算结果。
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleSchemaControls.map((control) => (
                    <div key={control.id} className="rounded-md border bg-background p-3 text-sm">
                      <strong className="block truncate">{control.name || '未命名控件'}</strong>
                      <span className="text-muted-foreground">{approvalControlType(control.type)} · {control.required ? '必填' : '选填'}</span>
                      <div className="mt-3 grid gap-2">
                        <Label className="text-xs">数据来源</Label>
                        <select
                          className="h-9 rounded-md border bg-background px-2 text-xs"
                          value={sourceKind(control.id)}
                          onChange={(event) => {
                            const kind = event.target.value;
                            if (kind === 'automatic') {
                              setFieldSource(control.id, undefined);
                            } else if (kind === 'manual') {
                              setFieldSource(control.id, {
                                kind: 'manual',
                                inputKey: control.id,
                                inputType: 'text',
                              });
                            } else if (kind === 'base-field') {
                              const firstField = availableTargetFields()[0];
                              if (!firstField) {
                                 setError('请先创建或读取该审批对应的提审数据表，再选择多维表格字段');
                                return;
                              }
                              setFieldSource(control.id, {
                                kind: 'base-field',
                                baseFieldId: firstField.baseFieldId,
                              });
                            } else if (kind === 'fixed-value') {
                              setFieldSource(control.id, { kind: 'fixed-value', value: '' });
                            } else if (kind === 'current-operator') {
                              setFieldSource(control.id, { kind: 'current-operator' });
                            } else if (kind === 'current-time') {
                              setFieldSource(control.id, { kind: 'current-time' });
                            } else if (kind === 'template') {
                              setFieldSource(control.id, {
                                kind: 'template',
                                parts: [
                                  { kind: 'literal', value: '' },
                                  { kind: 'literal', value: '' },
                                ],
                              });
                            } else if (kind === 'calculation') {
                              setFieldSource(control.id, {
                                kind: 'calculation',
                                operation: 'add',
                                operands: [
                                  { kind: 'manual', inputKey: `${control.id}-1`, inputType: 'number' },
                                  { kind: 'manual', inputKey: `${control.id}-2`, inputType: 'number' },
                                ],
                                scale: 2,
                                rounding: 'half-up',
                              });
                            } else if (kind === 'attachment-merge') {
                              setFieldSource(control.id, {
                                kind: 'attachment-merge',
                                sources: [
                                  { kind: 'manual', inputKey: `${control.id}-base`, inputType: 'attachment' },
                                  { kind: 'manual', inputKey: `${control.id}-extra`, inputType: 'attachment' },
                                ],
                              });
                            }
                          }}
                        >
                          <option value="automatic">自动绑定当前字段</option>
                          <option value="base-field">多维表格字段</option>
                          <option value="manual">手动输入</option>
                          <option value="fixed-value">固定值</option>
                          <option value="current-operator">当前操作人</option>
                          <option value="current-time">当前时间</option>
                          <option value="template">文本模板（多来源拼接）</option>
                          <option value="calculation">受控数字计算</option>
                          <option value="attachment-merge">附件合并</option>
                        </select>
                        {manualSource(control.id) && (
                          <div className="grid gap-2">
                            <Input
                              value={manualSource(control.id)?.inputKey || ''}
                              onChange={(event) => {
                                const current = manualSource(control.id);
                                if (current) {
                                  setFieldSource(control.id, { ...current, inputKey: event.target.value });
                                }
                              }}
                              placeholder="输入项名称"
                            />
                            <select
                              className="h-9 rounded-md border bg-background px-2 text-xs"
                              value={manualSource(control.id)?.inputType || 'text'}
                              onChange={(event) => {
                                const current = manualSource(control.id);
                                if (current) {
                                  setFieldSource(control.id, {
                                    ...current,
                                    inputType: event.target.value as 'text' | 'number' | 'amount' | 'date-time' | 'attachment',
                                  });
                                }
                              }}
                            >
                              <option value="text">文本</option>
                              <option value="number">数字</option>
                              <option value="amount">金额</option>
                              <option value="date-time">日期/时间</option>
                              <option value="attachment">附件</option>
                            </select>
                          </div>
                        )}
                        {sourceKind(control.id) === 'base-field' && (
                          <select
                            className="h-9 rounded-md border bg-background px-2 text-xs"
                            value={baseFieldSource(control.id)?.baseFieldId || ''}
                            onChange={(event) => setFieldSource(control.id, {
                              kind: 'base-field',
                              baseFieldId: event.target.value,
                            })}
                            disabled={!availableTargetFields().length}
                          >
                            {!availableTargetFields().length && <option value="">暂无可用字段</option>}
                            {availableTargetFields().map((field) => (
                              <option key={field.baseFieldId} value={field.baseFieldId}>
                                {field.baseFieldName} · {field.baseFieldId}
                              </option>
                            ))}
                          </select>
                        )}
                        {fixedValueSource(control.id) && (
                          <Input
                            value={String(fixedValueSource(control.id)?.value ?? '')}
                            onChange={(event) => {
                              const current = fixedValueSource(control.id);
                              if (current) {
                                setFieldSource(control.id, { ...current, value: event.target.value });
                              }
                            }}
                            placeholder="固定值"
                          />
                        )}
                        {templateSource(control.id) && (
                          <div className="grid gap-2 rounded-md border bg-muted/20 p-2">
                            <span className="text-xs text-muted-foreground">按顺序拼接文本来源，仅提交到当前审批控件</span>
                            {templateSource(control.id)?.parts.map((part, partIndex) => (
                              <div key={`${control.id}-template-${partIndex}`} className="grid gap-2 md:grid-cols-[auto_1fr]">
                                <select
                                  className="h-9 rounded-md border bg-background px-2 text-xs"
                                  value={part.kind}
                                  onChange={(event) => {
                                    const current = templateSource(control.id);
                                    if (!current) return;
                                    const nextParts = [...current.parts];
                                    nextParts[partIndex] = event.target.value === 'literal'
                                      ? { kind: 'literal', value: '' }
                                      : { kind: 'source', source: atomicInput('manual', `${control.id}-part-${partIndex}`) };
                                    setFieldSource(control.id, { ...current, parts: nextParts });
                                  }}
                                >
                                  <option value="literal">固定文字</option>
                                  <option value="source">手动来源</option>
                                </select>
                                {part.kind === 'literal' ? (
                                  <Input
                                    value={part.value}
                                    onChange={(event) => {
                                      const current = templateSource(control.id);
                                      if (!current) return;
                                      const nextParts = [...current.parts];
                                      nextParts[partIndex] = { kind: 'literal', value: event.target.value };
                                      setFieldSource(control.id, { ...current, parts: nextParts });
                                    }}
                                    placeholder="固定文字"
                                  />
                                ) : (
                                  <Input
                                    value={part.source.kind === 'manual' ? part.source.inputKey : ''}
                                    onChange={(event) => {
                                      const current = templateSource(control.id);
                                      if (!current || part.kind !== 'source') return;
                                      const nextParts = [...current.parts];
                                      nextParts[partIndex] = {
                                        kind: 'source',
                                        source: { kind: 'manual', inputKey: event.target.value, inputType: 'text' },
                                      };
                                      setFieldSource(control.id, { ...current, parts: nextParts });
                                    }}
                                      placeholder="手动输入项名称"
                                  />
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {calculationSource(control.id) && (
                          <div className="grid gap-2 rounded-md border bg-muted/20 p-2">
                            <span className="text-xs text-muted-foreground">受控计算使用十进制定点运算，结果仅写入当前数字/金额控件</span>
                            <select
                              className="h-9 rounded-md border bg-background px-2 text-xs"
                              value={calculationSource(control.id)?.operation || 'add'}
                              onChange={(event) => {
                                const current = calculationSource(control.id);
                                if (current) setFieldSource(control.id, {
                                  ...current,
                                  operation: event.target.value as Extract<TargetFieldSourceInput, { kind: 'calculation' }>['operation'],
                                });
                              }}
                            >
                              <option value="add">相加</option>
                              <option value="sum">求和</option>
                              <option value="average">平均值</option>
                              <option value="min">最小值</option>
                              <option value="max">最大值</option>
                              <option value="subtract">减法</option>
                              <option value="multiply">乘法</option>
                              <option value="divide">除法</option>
                            </select>
                            {calculationSource(control.id)?.operands.map((operand, operandIndex) => (
                              <Input
                                key={`${control.id}-operand-${operandIndex}`}
                                value={operand.kind === 'manual' ? operand.inputKey : operand.kind === 'fixed-value' ? String(operand.value || '') : ''}
                                onChange={(event) => {
                                  const current = calculationSource(control.id);
                                  if (!current) return;
                                  const operands = [...current.operands];
                                  operands[operandIndex] = {
                                    kind: 'manual',
                                    inputKey: event.target.value,
                                    inputType: control.type.toLowerCase() === 'amount' ? 'amount' : 'number',
                                  };
                                  setFieldSource(control.id, { ...current, operands });
                                }}
                                placeholder={`第 ${operandIndex + 1} 个手动数字来源名称`}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3. 创建同步表 / 提审表</CardTitle>
            <CardDescription>同一审批流可分别创建实例同步表和提审表；字段映射由审批结构自动生成。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-[1fr_auto]">
            <div className="grid gap-2">
              <Label htmlFor="table-name">提审表名称（可选）</Label>
              <Input id="table-name" value={tableName} onChange={(event) => setTableName(event.target.value)} placeholder="默认使用审批名称-提审" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="source-table-name">同步表名称（可选）</Label>
              <Input id="source-table-name" value={sourceTableName} onChange={(event) => setSourceTableName(event.target.value)} placeholder="默认使用审批名称" />
            </div>
            <div className="flex flex-wrap items-end gap-2 md:col-span-2">
              <Button type="button" onClick={() => void createTargetTable()} disabled={working}>
                {working ? <LoaderCircle className="animate-spin" /> : <Table2 />}创建提审表
              </Button>
              <Button type="button" variant="outline" onClick={() => void createSourceTable()} disabled={working}>
                {working ? <LoaderCircle className="animate-spin" /> : <Table2 />}创建同步表
              </Button>
              <Button type="button" variant="outline" onClick={() => void syncSourceNow()} disabled={working}>
                {working ? <LoaderCircle className="animate-spin" /> : <Play />}立即同步
              </Button>
            </div>
            {sourceResult && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground md:col-span-2">
                <CheckCircle2 className="size-4 text-primary" />
                已绑定同步表：{sourceResult.sourceTableBinding.baseTableName} · {sourceResult.syncedFieldBindings.length} 个字段
              </div>
            )}
            {targetResult && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground md:col-span-2">
                <CheckCircle2 className="size-4 text-primary" />
                已建立 {targetResult.targetFieldBindings.length} 个控件字段和 4 个回写字段
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>4. 页面与同步策略</CardTitle>
            <CardDescription>按多维表格保存页面标题和审批实例同步频率；所有绑定都来自当前租户配置。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="page-title">页面标题</Label>
              <Input id="page-title" value={pageTitle} onChange={(event) => setPageTitle(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sync-interval">审批实例同步间隔（秒）</Label>
              <Input
                id="sync-interval"
                type="number"
                min={10}
                max={86400}
                value={sourceSyncIntervalSeconds}
                onChange={(event) => setSourceSyncIntervalSeconds(Number(event.target.value))}
              />
            </div>
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={() => void saveProfile()} disabled={working}>
                {working ? <LoaderCircle className="animate-spin" /> : <Save />}保存多维表格配置
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>5. 从当前选中记录发起审批</CardTitle>
            <CardDescription>服务端会重新读取记录、校验权限和必填项；重复点击不会重复创建同一批审批。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2 md:grid-cols-[1fr_auto]">
              <div className="grid gap-2">
                <Label htmlFor="launch-approval-code">已配置目标审批流</Label>
                <select
                  id="launch-approval-code"
                  className="h-10 rounded-md border bg-background px-3 text-sm"
                  value={launchApprovalCode}
                  onChange={(event) => {
                    setLaunchApprovalCode(event.target.value);
                    setLaunchSchema(null);
                    setLaunchResult(null);
                    setLaunchIdempotencyKey('');
                  }}
                >
                  <option value="">请选择目标审批流</option>
                  {profileTargets(profile).map((target) => (
                    <option key={target.targetTableBinding.targetApprovalCode} value={target.targetTableBinding.targetApprovalCode}>
                      {target.targetTableBinding.baseTableName} · {target.targetTableBinding.targetApprovalCode}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end gap-2">
                <Button type="button" variant="outline" onClick={() => void loadLaunchSchema()} disabled={working}>
                  {working ? <LoaderCircle className="animate-spin" /> : <Search />}读取发起表单
                </Button>
                <Button type="button" variant="outline" onClick={() => void readSelectedRecords()} disabled={working}>
                  {working ? <LoaderCircle className="animate-spin" /> : <Table2 />}读取选中记录
                </Button>
              </div>
            </div>
            <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
              当前已选择 {selectedRecordIds.length} 条记录
              {selectedRecordIds.length ? `：${selectedRecordIds.join('、')}` : '。请回到目标提审数据表选择记录。'}
            </div>
            {launchSchema && profileTargets(profile).find((target) => target.targetTableBinding.targetApprovalCode === launchApprovalCode) && (
              <div className="grid gap-3 rounded-lg border p-4">
                <strong>手动输入项</strong>
                  {profileTargets(profile)
                  .find((target) => target.targetTableBinding.targetApprovalCode === launchApprovalCode)
                  ?.targetFieldBindings
                  .map((binding) => {
                     const sources = launchManualSources(binding);
                     const control = launchSchema.controls.find((item) => item.id === binding.targetControlId);
                     if (!sources.length || !control) return null;
                     return sources.map((source) => source.inputType === 'attachment' ? (
                       <div key={`${binding.targetControlId}-${source.inputKey}`} className="grid gap-2">
                         <Label htmlFor={`launch-file-${source.inputKey}`}>{control.name}（附件）</Label>
                         <Input
                           id={`launch-file-${source.inputKey}`}
                           type="file"
                           multiple
                           onChange={(event) => {
                             setManualFiles((current) => ({
                               ...current,
                               [source.inputKey]: Array.from(event.target.files || []),
                             }));
                             setLaunchIdempotencyKey('');
                           }}
                         />
                       </div>
                     ) : (
                       <div key={`${binding.targetControlId}-${source.inputKey}`} className="grid gap-2">
                         <Label htmlFor={`launch-input-${source.inputKey}`}>{control.name} · {source.inputKey}</Label>
                         <Input
                           id={`launch-input-${source.inputKey}`}
                           type={source.inputType === 'date-time' ? 'datetime-local' : source.inputType === 'text' ? 'text' : 'number'}
                           value={String(manualInputs[source.inputKey] ?? '')}
                           onChange={(event) => {
                             setManualInputs((current) => ({ ...current, [source.inputKey]: event.target.value }));
                             setLaunchIdempotencyKey('');
                           }}
                         />
                       </div>
                     ));
                  })}
              </div>
            )}
            <div className="flex justify-end">
              <Button type="button" onClick={() => void launchTargetApproval()} disabled={working || !selectedRecordIds.length || !launchApprovalCode}>
                {working ? <LoaderCircle className="animate-spin" /> : <Play />}发起目标审批
              </Button>
            </div>
            {launchResult && (
              <div className={`rounded-lg border p-3 text-sm ${launchResult.writebackComplete ? 'border-primary/30 bg-primary/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
                <strong>{launchResult.writebackComplete ? '审批已发起并完成首次回写' : '审批已发起，但回写尚未全部完成'}</strong>
                <div className="mt-1 text-muted-foreground">批次 ID：{launchResult.batchId}</div>
                {launchResult.results.map((item) => (
                  <div key={item.recordId} className="text-muted-foreground">
                    {item.recordId}：{item.instanceCode || item.error || '未提交'}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
};

export default PluginConfigPage;
