import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

// `pnpm test:unit`: every test file except those that drive Chromium (they fail without a browser), in well under a
// minute. A new test that opens a browser goes on this list.
const BROWSER_TESTS = [
  'agent-loop', 'agent-tools', 'agent-two-page', 'auth-next', 'auth-via-guard', 'e2e-agent', 'e2e-download', 'e2e-import',
  'e2e-sap', 'e2e-sap-realistic', 'e2e-sap-sso', 'e2e-sap-sso2', 'e2e-sap-ui5', 'import-steps-document', 'lane-idle', 'locator',
  'prove', 'run-auth', 'run-auth-via', 'run-basic', 'run-capture', 'run-change-password', 'run-code-workflow',
  'run-code-workflow-resend', 'run-data', 'run-files', 'run-input', 'run-locator-vars', 'run-secret-fill', 'run-writes',
  'script-lane', 'session', 'session-connect', 'session-egress', 'session-redirects', 'snapshot', 'start-page', 'step-hooks',
  'surface-browser', 'task', 'trace',
];

export default mergeConfig(base, defineConfig({ test: { exclude: [...configDefaults.exclude, ...BROWSER_TESTS.map((name) => `test/${name}.test.ts`)] } }));
