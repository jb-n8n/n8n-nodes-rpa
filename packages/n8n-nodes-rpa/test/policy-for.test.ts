import { describe, expect, it } from 'vitest';
// The engine's golden builders (index.ts re-exports messages.ts). Tests may load the engine; node sources may not.
import { notHttp, USE_CASE_WORDS } from 'n8n-rpa-engine';
import {
  ALLOWED_HOST_NOT_HTTP, ALLOWED_HOSTS_WITH_SITE_LOGIN, checkUrl, SITE_LOGIN_ONLY_RUN_OR_SIGN, ConfigError, policyFor, RUN_STEPS_NEEDS_START, START_URL_NOT_ON_SITE_LOGIN,
  URL_HAS_USERINFO, URL_NEEDS_HOST, URL_NOT_VALID, URL_REQUIRED, UrlPolicyError, siteLoginConfig, type PolicyOperation, type SiteLogin,
} from '../nodes/Playwright/config.js';

const SITE_LOGIN: SiteLogin = siteLoginConfig({
  loginUrl: 'https://app.example.com/login', username: 'user-1', password: 'pass-1',
  navHosts: 'app.example.com, files.example.com', subresourceHosts: 'cdn.example.com',
  allowedSubmits: 'POST app.example.com/export',
});
const none = { allowedHosts: [] as string[], allowPrivateNetwork: false };
const OPERATIONS: PolicyOperation[] = ['quick', 'fillForm', 'runSteps', 'signSteps'];
const thrown = (fn: () => unknown): Error => {
  try { fn(); } catch (e) { return e as Error; }
  throw new Error('expected a throw');
};

describe('policyFor without a Site Login', () => {
  it('takes declared submits from the steps only for Run Steps without a Site Login', () => {
    const at = (operation: PolicyOperation) => policyFor({ url: 'https://example.com/form', allowedHosts: [], allowPrivateNetwork: false, operation });
    expect(at('runSteps').submitsFromSteps).toBe(true);
    for (const op of ['quick', 'fillForm', 'signSteps'] as const) expect(at(op).submitsFromSteps).toBe(false);
    const withLogin = policyFor({ siteLogin: SITE_LOGIN, allowedHosts: [], allowPrivateNetwork: false, operation: 'runSteps' });
    expect(withLogin.submitsFromSteps).toBeFalsy();
  });
  it('allows the URL host plus Allowed Hosts, normalised and deduped, and blocks writes by logging them', () => {
    const p = policyFor({
      ...none, url: 'https://Example.com/pricing?plan=pro', operation: 'quick',
      allowedHosts: ['cdn.example.com', 'EXAMPLE.com', 'https://api.example.com:443', 'cdn.example.com.'],
    });
    expect(p).toEqual({
      startUrl: 'https://example.com/pricing?plan=pro',
      navHosts: ['example.com', 'cdn.example.com', 'api.example.com'],
      subresourceHosts: [], login: [], allowedSubmits: [], writeMode: 'block', allowPrivateNetwork: false, submitsFromSteps: false,
    });
  });
  it('uses the sub-resource wildcard only when Allowed Hosts is empty and the operation is not Fill and Submit Form', () => {
    for (const operation of ['quick', 'runSteps', 'signSteps'] as const) {
      expect(policyFor({ ...none, url: 'https://example.com/', operation }).subresourceHosts).toBe('*');
    }
    expect(policyFor({ ...none, url: 'https://example.com/', operation: 'fillForm' }).subresourceHosts).toEqual([]);
    for (const operation of OPERATIONS) {
      expect(policyFor({ ...none, url: 'https://example.com/', allowedHosts: ['cdn.example.com'], operation }).subresourceHosts).toEqual([]);
    }
  });
  it('keeps the port of a non-default port and the path, query and fragment of the URL', () => {
    const p = policyFor({ ...none, url: 'http://127.0.0.1:8080/public/table#top', operation: 'quick' });
    expect(p.startUrl).toBe('http://127.0.0.1:8080/public/table#top');
    expect(p.navHosts).toEqual(['127.0.0.1:8080']);
  });
  it('needs a URL: Run Steps says Start URL or Site Login, the other operations say URL is required', () => {
    const runSteps = thrown(() => policyFor({ ...none, operation: 'runSteps' }));
    expect(runSteps).toBeInstanceOf(ConfigError);
    expect(runSteps.message).toBe(RUN_STEPS_NEEDS_START);
    for (const operation of ['quick', 'fillForm', 'signSteps'] as const) {
      const e = thrown(() => policyFor({ ...none, url: '  ', operation }));
      expect(e).toBeInstanceOf(ConfigError);
      expect(e.message).toBe(URL_REQUIRED);
    }
  });
  it('a bad Allowed Hosts entry is a configuration error (host normalisation, no wildcards)', () => {
    expect(thrown(() => policyFor({ ...none, url: 'https://example.com/', allowedHosts: ['*.example.com'], operation: 'quick' }))).toBeInstanceOf(ConfigError);
    expect(thrown(() => policyFor({ ...none, url: 'https://example.com/', allowedHosts: ['example.com/path'], operation: 'quick' }))).toBeInstanceOf(ConfigError);
  });
  it('Allowed Hosts takes http(s) sites or bare hosts only: ws://, wss://, ftp:// are configuration errors', () => {
    for (const entry of ['ws://cdn.example.com', 'wss://cdn.example.com', 'WSS://cdn.example.com:8443', 'ftp://files.example.com']) {
      const e = thrown(() => policyFor({ ...none, url: 'https://example.com/', allowedHosts: [entry], operation: 'quick' }));
      expect(e, entry).toBeInstanceOf(ConfigError);
      expect(e.message, entry).toBe(ALLOWED_HOST_NOT_HTTP(`"${entry}"`));
    }
    const userinfo = thrown(() => policyFor({ ...none, url: 'https://example.com/', allowedHosts: ['wss://u:secret@cdn.example.com'], operation: 'quick' }));
    expect(userinfo.message).not.toContain('secret');
    const p = policyFor({ ...none, url: 'https://example.com/', allowedHosts: ['cdn.example.com', 'http://api.example.com:8080', 'HTTPS://img.example.com'], operation: 'quick' });
    expect(p.navHosts).toEqual(['example.com', 'cdn.example.com', 'api.example.com:8080', 'img.example.com']);
  });
});

describe('checkUrl', () => {
  it('refuses a non-http(s) URL with the golden message, the same text the engine uses', () => {
    const golden = 'URL must start with http:// or https:// (got "file:").';
    expect(notHttp('file:')).toBe(golden);
    const e = thrown(() => checkUrl('file:///etc/passwd'));
    expect(e).toBeInstanceOf(UrlPolicyError);
    expect(e).not.toBeInstanceOf(ConfigError);
    expect(e.message).toBe(golden);
    expect(thrown(() => checkUrl('javascript:alert(1)')).message).toBe(notHttp('javascript:'));
    expect(thrown(() => checkUrl('ftp://files.example.com/a.csv')).message).toBe(notHttp('ftp:'));
    expect(thrown(() => policyFor({ ...none, url: 'file:///etc/passwd', operation: 'quick' }))).toBeInstanceOf(UrlPolicyError);
  });
  it('refuses userinfo, an empty host and unparseable text, and never echoes the userinfo', () => {
    const withUser = thrown(() => checkUrl('https://user:pw@x.com/'));
    expect(withUser).toBeInstanceOf(UrlPolicyError);
    expect(withUser.message).toBe(URL_HAS_USERINFO);
    expect(withUser.message).not.toContain('user:pw');
    expect(thrown(() => checkUrl('https://user@x.com/')).message).toBe(URL_HAS_USERINFO);
    expect(thrown(() => checkUrl('https:///path')).message).toBe(URL_NEEDS_HOST);
    expect(thrown(() => checkUrl('http:/x.com/a')).message).toBe(URL_NEEDS_HOST);
    expect(thrown(() => checkUrl('https://example.com./')).message).toBe(URL_NEEDS_HOST);
    expect(thrown(() => checkUrl('https://')).message).toBe(URL_NOT_VALID);
    expect(thrown(() => checkUrl('not a url')).message).toBe(URL_NOT_VALID);
    expect(thrown(() => checkUrl('')).message).toBe(URL_NOT_VALID);
  });
  it('returns the parsed URL for http and https', () => {
    expect(checkUrl(' https://example.com/a?b=1 ').href).toBe('https://example.com/a?b=1');
    expect(checkUrl('http://example.com').href).toBe('http://example.com/');
  });
});

describe('policyFor with a Site Login', () => {
  it('uses the credential policy unchanged apart from fatal writes and the private-network option', () => {
    expect(policyFor({ ...none, siteLogin: SITE_LOGIN, operation: 'runSteps' })).toEqual({ ...SITE_LOGIN.policy, writeMode: 'fatal', allowPrivateNetwork: false });
    expect(policyFor({ ...none, siteLogin: SITE_LOGIN, url: '', operation: 'signSteps' }).startUrl).toBe('https://app.example.com/login');
  });
  it('a Start URL on one of its navigation hosts replaces the start page', () => {
    const p = policyFor({ ...none, siteLogin: SITE_LOGIN, url: 'https://files.example.com/reports', operation: 'runSteps' });
    expect(p).toEqual({ ...SITE_LOGIN.policy, startUrl: 'https://files.example.com/reports', writeMode: 'fatal', allowPrivateNetwork: false });
  });
  it('a Start URL off its navigation hosts is a configuration error', () => {
    const e = thrown(() => policyFor({ ...none, siteLogin: SITE_LOGIN, url: 'https://evil.example.com/x', operation: 'runSteps' }));
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.message).toBe(START_URL_NOT_ON_SITE_LOGIN('evil.example.com'));
    expect(e.message).toBe("Start URL host evil.example.com is not one of the Site Login credential's Sites the Browser May Open.");
  });
  it('a non-http Start URL is still a policy error, not a configuration error', () => {
    expect(thrown(() => policyFor({ ...none, siteLogin: SITE_LOGIN, url: 'file:///etc/passwd', operation: 'runSteps' }))).toBeInstanceOf(UrlPolicyError);
  });
  it('a Site Login is only for Run Steps and Sign Steps: quick operations and Fill and Submit Form refuse it', () => {
    for (const operation of ['quick', 'fillForm'] as const) {
      const e = thrown(() => policyFor({ ...none, siteLogin: SITE_LOGIN, url: 'https://app.example.com/x', operation }));
      expect(e, operation).toBeInstanceOf(ConfigError);
      expect(e.message).toBe(SITE_LOGIN_ONLY_RUN_OR_SIGN);
    }
    expect(policyFor({ ...none, siteLogin: SITE_LOGIN, operation: 'signSteps' }).writeMode).toBe('fatal');
  });
  it('Allowed Hosts together with a Site Login is a configuration error', () => {
    const e = thrown(() => policyFor({ ...none, siteLogin: SITE_LOGIN, allowedHosts: ['cdn.other.com'], operation: 'runSteps' }));
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.message).toBe(ALLOWED_HOSTS_WITH_SITE_LOGIN);
  });
});

describe('policyFor private-network option and wording', () => {
  it('copies Allow Private Network into the policy in every branch', () => {
    for (const allowPrivateNetwork of [true, false]) {
      expect(policyFor({ allowedHosts: [], allowPrivateNetwork, siteLogin: SITE_LOGIN, operation: 'runSteps' }).allowPrivateNetwork).toBe(allowPrivateNetwork);
      for (const operation of OPERATIONS) {
        expect(policyFor({ allowedHosts: [], allowPrivateNetwork, url: 'https://example.com/', operation }).allowPrivateNetwork).toBe(allowPrivateNetwork);
        expect(policyFor({ allowedHosts: ['cdn.example.com'], allowPrivateNetwork, url: 'https://example.com/', operation }).allowPrivateNetwork).toBe(allowPrivateNetwork);
      }
    }
  });
  it('never uses the sub-resource wildcard when Allow Private Network is on (private-network opt-in)', () => {
    for (const operation of OPERATIONS) {
      const p = policyFor({ allowedHosts: [], allowPrivateNetwork: true, url: 'http://10.0.0.5:8080/public/table', operation });
      expect(p.subresourceHosts).toEqual([]);
      expect(p.navHosts).toEqual(['10.0.0.5:8080']);
    }
  });
  it('never sets frameHostWrites (only the engine\'s noWritePolicy does)', () => {
    const policies = [
      policyFor({ ...none, siteLogin: SITE_LOGIN, operation: 'runSteps' }),
      ...OPERATIONS.map((operation) => policyFor({ ...none, url: 'https://example.com/', operation })),
      policyFor({ ...none, url: 'https://example.com/', allowedHosts: ['cdn.example.com'], operation: 'quick' }),
    ];
    for (const p of policies) expect(Object.keys(p)).not.toContain('frameHostWrites');
  });
  it('no message uses a use-case word', () => {
    for (const m of [ALLOWED_HOST_NOT_HTTP('"ws://x.example.com"'), SITE_LOGIN_ONLY_RUN_OR_SIGN, ALLOWED_HOSTS_WITH_SITE_LOGIN, START_URL_NOT_ON_SITE_LOGIN('example.com'), RUN_STEPS_NEEDS_START, URL_REQUIRED, URL_NOT_VALID, URL_NEEDS_HOST, URL_HAS_USERINFO]) {
      expect(m).not.toMatch(USE_CASE_WORDS);
    }
  });
});
