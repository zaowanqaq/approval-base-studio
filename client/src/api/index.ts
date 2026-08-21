import { logger } from '@lark-apaas/client-toolkit/logger';
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  ApprovalSchema,
  ApprovalDefinitionSearchResponse,
  BasePluginProfileResponse,
  BasePluginProfileSaveRequest,
  TargetLaunchRequest,
  TargetLaunchResponse,
  TargetFieldMatchSuggestion,
  TargetProvisioningRequest,
  TargetProvisioningResponse,
  SourceSyncResponse,
} from '@shared/approval';

type BackendError = {
  response?: {
    status?: number;
    data?: { message?: string; error?: { message?: string } };
  };
};

export type FeishuAuthStatus = {
  name: string;
  openId: string;
  authMode: 'oauth';
  verified: boolean;
  authorized: boolean;
  authorizeUrl?: string;
};

async function pluginRequest<T>(
  url: string,
  method: 'GET' | 'PUT' | 'POST',
  data?: unknown,
): Promise<T> {
  try {
    const paymentSession = window.localStorage.getItem('payment_feishu_session');
    const isFormData = data instanceof FormData;
    const response = await axiosForBackend({
      url,
      method,
      data,
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(paymentSession ? { 'X-Payment-Session': paymentSession } : {}),
      },
    });
    const refreshedSession = response.headers?.['x-payment-session'];
    if (typeof refreshedSession === 'string' && refreshedSession) {
      window.localStorage.setItem('payment_feishu_session', refreshedSession);
    }
    return response.data as T;
  } catch (cause: unknown) {
    const error = cause as BackendError;
    const payload = error.response?.data;
    const message =
      payload?.message ||
      payload?.error?.message ||
      `请求失败（${error.response?.status || '网络异常'}）`;
    logger.error('插件配置请求失败', cause);
    throw new Error(message);
  }
}

export const pluginProfileApi = {
  searchLaunchable: (keyword: string, pageToken?: string) =>
    pluginRequest<ApprovalDefinitionSearchResponse>(
      `/api/approvals/launchable?${new URLSearchParams({
        keyword,
        ...(pageToken ? { pageToken } : {}),
      })}`,
      'GET',
    ),
  readSchema: (approvalCode: string) =>
    pluginRequest<ApprovalSchema>(
      `/api/approvals/schema?${new URLSearchParams({ approvalCode })}`,
      'GET',
    ),
  suggestTargetMatches: (input: { approvalCode: string; baseUrl: string; tableId: string }) =>
    pluginRequest<TargetFieldMatchSuggestion[]>(
      `/api/approvals/target/matches?${new URLSearchParams(input)}`,
      'GET',
    ),
  get: (baseUrl: string) =>
    pluginRequest<BasePluginProfileResponse | null>(
      `/api/plugin-profile?${new URLSearchParams({ baseUrl })}`,
      'GET',
    ),
  save: (input: BasePluginProfileSaveRequest) =>
    pluginRequest<BasePluginProfileResponse>('/api/plugin-profile', 'PUT', input),
  provisionTarget: (input: TargetProvisioningRequest) =>
    pluginRequest<TargetProvisioningResponse>(
      '/api/approvals/target/provision',
      'POST',
      input,
    ),
  syncSource: (input: { baseUrl: string; approvalCode: string }) =>
    pluginRequest<SourceSyncResponse>('/api/approvals/source/sync', 'POST', input),
  launchTarget: (
    input: TargetLaunchRequest,
    files: Record<string, File[]> = {},
  ) => {
    const body = new FormData();
    body.append('payload', JSON.stringify(input));
    for (const [inputKey, inputFiles] of Object.entries(files)) {
      for (const file of inputFiles) body.append(`manualInput:${inputKey}`, file);
    }
    return pluginRequest<TargetLaunchResponse>(
      '/api/approvals/target/launch',
      'POST',
      body,
    );
  },
};

export const authApi = {
  me: () => pluginRequest<FeishuAuthStatus>('/api/auth/me', 'GET'),
};
