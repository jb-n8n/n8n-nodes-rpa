import {
  NodeOperationError, type ICredentialsDecrypted, type ICredentialTestFunctions, type IExecuteFunctions, type INodeCredentialTestResult,
  type INodeExecutionData, type INodeType, type INodeTypeDescription,
} from 'n8n-workflow';
import type { NodeContext } from './context.js';
import {
  browserTestResult, desktopRunnerTestResult, redisTestResult, scriptSigningResult, secretVariablesTestResult, siteLoginTestResult,
} from './credential-tests.js';
import { properties, SUBTITLE } from './description/index.js';
import { INPUTS_EXPRESSION, OUTPUTS_EXPRESSION } from './description/io.js';
import { loadEngine, type Engine } from './engine.js';
import { executeQuickOp } from './operations/quick.js';
import { executeImportSteps } from './operations/importSteps.js';
import { executeRunSteps } from './operations/runSteps.js';
import { executeSignSteps } from './operations/signSteps.js';

type Operation = (ctx: NodeContext, engine: Engine) => Promise<INodeExecutionData[][]>;

/** Operation value → its implementation. */
export const DISPATCH: Record<string, Operation> = {
  runSteps: (ctx, engine) => executeRunSteps(ctx, engine),
  signSteps: (ctx, engine) => executeSignSteps(ctx, engine),
  importSteps: (ctx, engine) => executeImportSteps(ctx, engine),
  screenshot: (ctx, engine) => executeQuickOp(ctx, engine, 'screenshot'),
  getPage: (ctx, engine) => executeQuickOp(ctx, engine, 'getPage'),
  pdf: (ctx, engine) => executeQuickOp(ctx, engine, 'pdf'),
  extract: (ctx, engine) => executeQuickOp(ctx, engine, 'extract'),
  fillForm: (ctx, engine) => executeQuickOp(ctx, engine, 'fillForm'),
  download: (ctx, engine) => executeQuickOp(ctx, engine, 'download'),
};

export class Playwright implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'RPA',
    name: 'playwright',
    icon: { light: 'file:rpa.svg', dark: 'file:rpa.svg' },
    group: ['transform'],
    // Version 2 shows less (config.ts NODE_VERSIONS); a stored version 1 node shows, keeps and runs what it did.
    version: [1, 2],
    // Built from OPERATIONS (description/index.ts), so a new operation needs no edit here.
    subtitle: SUBTITLE,
    description: 'Robotic process automation for n8n: screenshots, page text, PDFs, tables, forms and downloads, plus signed step lists that repair themselves with AI. Self-hosted only.',
    defaults: { name: 'RPA' },
    inputs: INPUTS_EXPRESSION,
    outputs: OUTPUTS_EXPRESSION,
    // Literal names: the credential-test-required and valid-credential-references lint rules read only string literals.
    // test/node.test.ts checks they equal CREDENTIALS, which the operations read.
    // Runs On (Run Steps and Import Steps) hides slots only through `hide`: a version 1 node saved without it (or with an
    // expression) shows every slot, so n8n keeps every credential it holds. config.ts HIDDEN_BY_RUNS_ON says the same.
    credentials: [
      // Not required: Run Steps with desktop steps needs the RPA Desktop Runner instead. Every operation that runs a browser
      // refuses at run time, naming RPA Browser, when it is missing (operations/common.ts browserCredentials).
      { name: 'playwrightBrowserApi', displayName: 'RPA Browser', required: false, testedBy: 'browserTest', displayOptions: { hide: { operation: ['signSteps'], runsOn: ['desktop'] } } },
      { name: 'playwrightSiteLoginApi', displayName: 'RPA Site Login', required: false, testedBy: 'siteLoginTest', displayOptions: { show: { operation: ['runSteps', 'signSteps', 'importSteps'] }, hide: { runsOn: ['desktop'] } } },
      // Required at run time for Sign Steps (and Run Steps with a signature); n8n cannot vary `required` by operation.
      { name: 'playwrightScriptSigningApi', displayName: 'RPA Step Signing', required: false, testedBy: 'scriptSigningTest', displayOptions: { show: { operation: ['runSteps', 'signSteps'] } } },
      // Version 2 hides it while Share Login Breaker Across Workers is off. In version 1 that field is never shown and
      // always on (description/runSteps.ts), so a version 1 node shows and keeps it as before.
      { name: 'playwrightRedisApi', displayName: 'RPA Redis', required: false, testedBy: 'guardRedisTest', displayOptions: { show: { operation: ['runSteps', 'importSteps'] }, hide: { runsOn: ['desktop'], shareAcrossWorkers: [false] } } },
      // Desktop steps (surface "desktop") run on a desktop runner; Run Steps refuses them without this credential.
      { name: 'rpaDesktopRunnerApi', displayName: 'RPA Desktop Runner', required: false, testedBy: 'desktopRunnerTest', displayOptions: { show: { operation: ['runSteps'] }, hide: { runsOn: ['browser'] } } },
      // Secret run variables, browser and desktop runs alike (operations/runSteps.ts withSecretVariables).
      { name: 'rpaSecretVariablesApi', displayName: 'RPA Secret Variables', required: false, testedBy: 'secretVariablesTest', displayOptions: { show: { operation: ['runSteps'] } } },
      // Import Steps never reads these two: it copies their id and name into the Run steps of the workflow file it makes,
      // so that file needs nothing picked. They come after the entries above on purpose: n8n reads a credential through the
      // first entry of its type, which Import Steps does not show, so a read here would fail ("Credentials not found").
      { name: 'playwrightScriptSigningApi', displayName: 'RPA Step Signing (only passed on to the workflow file)', required: false, testedBy: 'scriptSigningTest', displayOptions: { show: { operation: ['importSteps'] } } },
      { name: 'rpaDesktopRunnerApi', displayName: 'RPA Desktop Runner (only passed on to the workflow file)', required: false, testedBy: 'desktopRunnerTest', displayOptions: { show: { operation: ['importSteps'] }, hide: { runsOn: ['browser'] } } },
    ],
    properties,
  };

  methods = {
    credentialTest: {
      async browserTest(this: ICredentialTestFunctions, credential: ICredentialsDecrypted): Promise<INodeCredentialTestResult> {
        return await browserTestResult(credential.data ?? {}, await loadEngine());
      },
      async siteLoginTest(this: ICredentialTestFunctions, credential: ICredentialsDecrypted): Promise<INodeCredentialTestResult> {
        return siteLoginTestResult(credential.data ?? {});
      },
      async scriptSigningTest(this: ICredentialTestFunctions, credential: ICredentialsDecrypted): Promise<INodeCredentialTestResult> {
        return scriptSigningResult(credential.data ?? {});
      },
      async guardRedisTest(this: ICredentialTestFunctions, credential: ICredentialsDecrypted): Promise<INodeCredentialTestResult> {
        return await redisTestResult(credential.data ?? {});
      },
      async desktopRunnerTest(this: ICredentialTestFunctions, credential: ICredentialsDecrypted): Promise<INodeCredentialTestResult> {
        return await desktopRunnerTestResult(credential.data ?? {}, await loadEngine());
      },
      async secretVariablesTest(this: ICredentialTestFunctions, credential: ICredentialsDecrypted): Promise<INodeCredentialTestResult> {
        return secretVariablesTestResult(credential.data ?? {});
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const operation = this.getNodeParameter('operation', 0);
    const run = typeof operation === 'string' ? DISPATCH[operation] : undefined;
    if (!run) throw new NodeOperationError(this.getNode(), `Unknown operation "${String(operation)}"`);
    return await run(this, await loadEngine());
  }
}
