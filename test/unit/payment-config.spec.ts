import { PaymentConfig } from '../../server/modules/payment/payment.config';

const REQUIRED_ENV_NAMES = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'PAYMENT_SESSION_SECRET',
  'PAYMENT_BASE_TOKEN',
  'PAYMENT_TABLE_ID',
  'PROJECT_SYNC_TABLE_ID',
  'RESOURCE_SYNC_TABLE_ID',
  'PAYMENT_SYNC_TABLE_ID',
  'CLOUD_SYNC_TABLE_ID',
  'WALLET_SYNC_TABLE_ID',
] as const;

describe('PaymentConfig environment normalization', () => {
  const previousValues = new Map<string, string | undefined>();

  beforeEach(() => {
    previousValues.clear();
    for (const name of REQUIRED_ENV_NAMES) {
      previousValues.set(name, process.env[name]);
      process.env[name] = `redacted-${name.toLowerCase()}`;
    }
    previousValues.set('FEISHU_OAUTH_REDIRECT_URI', process.env.FEISHU_OAUTH_REDIRECT_URI);
    process.env.FEISHU_OAUTH_REDIRECT_URI = '"https://example.invalid/callback\\r\\n"';
  });

  afterEach(() => {
    for (const name of REQUIRED_ENV_NAMES) {
      const value = previousValues.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const redirectUri = previousValues.get('FEISHU_OAUTH_REDIRECT_URI');
    if (redirectUri === undefined) delete process.env.FEISHU_OAUTH_REDIRECT_URI;
    else process.env.FEISHU_OAUTH_REDIRECT_URI = redirectUri;
  });

  it('removes quoted literal line-ending escapes from OAuth configuration', () => {
    const config = new PaymentConfig();

    expect(config.appId).toBe('redacted-feishu_app_id');
    expect(config.oauthRedirectUri).toBe('https://example.invalid/callback');
  });
});
