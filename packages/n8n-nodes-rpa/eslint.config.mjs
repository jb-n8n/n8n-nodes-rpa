import { configs } from '@n8n/eslint-plugin-community-nodes';
import tseslint from 'typescript-eslint';

const base = configs.recommendedWithoutN8nCloudSupport;
const rules = {
  ...base.rules,
  // The engine (and playwright-core) are runtime dependencies by design: this is an unverified,
  // self-hosted-only package. CONTRIBUTING.md lists what n8n's full scan reports. n8n Cloud cannot run it.
  '@n8n/community-nodes/no-runtime-dependencies': 'off',
  // usableAsTool is omitted on purpose: tool conversion drops the model input and the
  // extra outputs, and n8n-workflow only allows `usableAsTool: true`, so it cannot be set to false.
  '@n8n/community-nodes/node-usable-as-tool': 'off',
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'test/**', 'scripts/**', 'templates/**', 'vitest.config.mts', 'eslint.config.mjs'] },
  { files: ['**/*.ts'], plugins: base.plugins, languageOptions: { parser: tseslint.parser }, rules },
  {
    files: ['package.json'],
    plugins: base.plugins,
    languageOptions: { parser: tseslint.parser, parserOptions: { extraFileExtensions: ['.json'] } },
    rules,
  },
];
