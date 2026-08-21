import { ApprovalConfig, FeishuService } from '../../server/modules/approval/feishu.service';

describe('Feishu OAuth configuration', () => {
  const previousValues = new Map<string, string | undefined>();

  beforeEach(() => {
    previousValues.clear();
    for (const name of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'APPROVAL_SESSION_SECRET', 'FEISHU_OAUTH_REDIRECT_URI']) {
      previousValues.set(name, process.env[name]);
    }
    process.env.FEISHU_APP_ID = 'redacted-app-id';
    process.env.FEISHU_APP_SECRET = 'redacted-app-secret';
    process.env.APPROVAL_SESSION_SECRET = 'redacted-session-secret';
    process.env.FEISHU_OAUTH_REDIRECT_URI = '"https://example.invalid/callback\\r\\n"';
  });

  afterEach(() => {
    for (const [name, value] of previousValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('removes quoted literal line-ending escapes from OAuth redirect configuration', () => {
    const config = new ApprovalConfig();
    const request = {
      headers: {},
      protocol: 'https',
      get: () => 'example.invalid',
    } as never;
    const service = new FeishuService(config);

    expect(config.appId).toBe('redacted-app-id');
    expect(service.createAuthorizeUrl(request)).toContain('redirect_uri=https%3A%2F%2Fexample.invalid%2Fcallback');
  });
});
