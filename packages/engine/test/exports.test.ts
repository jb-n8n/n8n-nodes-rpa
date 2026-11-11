import { describe, expect, it } from 'vitest';

/**
 * The engine's runtime exports, pinned. A task that adds or removes an export updates this
 * list in the same commit. Type-only exports (interfaces, types) do not exist at runtime and are not listed.
 */
const EXPORTS = [
  'AGENT_TOOLS', 'ALSO_CHANGED', 'AgentTools', 'BROWSER_CERT_NOT_TRUSTED', 'BROWSER_CERT_NOT_TRUSTED_CDP', 'BROWSER_FINGERPRINT_INVALID',
  'BROWSER_FINGERPRINT_MISMATCH', 'BROWSER_FINGERPRINT_NEEDS_WSS', 'BrowserUnavailableError', 'CANCELLED', 'CONNECT_TIMEOUT_MS',
  'CompileError', 'DEFAULT_BUDGET_MS', 'DEFAULT_CODE_TIMEOUT_MS', 'DEFAULT_LEASE_MS', 'DEFAULT_MAX_ACTIONS', 'DEFAULT_MAX_BYTES',
  'DEFAULT_MAX_TOKENS', 'DEFAULT_MIME', 'DEFAULT_RUNNER_PORT', 'DENYLIST', 'DESKTOP_CHANGES_MISMATCH', 'DESKTOP_EVIDENCE_INVALID',
  'DESKTOP_FLAGS_INCOMPLETE', 'DESKTOP_NEEDS_FIRST_VERSION', 'DESKTOP_VERBS', 'DESKTOP_WRITES_PRESET', 'DETECTED_PREFIX',
  'DOWNLOAD_NEEDS_BROWSER_SERVER', 'DesktopUnavailableError', 'EXPORT_DIR_TOKEN', 'EXTRACT_FIELDS_DROPPED', 'ElementCannotActError',
  'ElementNotFoundError', 'ElementNotUniqueError', 'ExpectedFileMissingError', 'FIELDS_UNSUPPORTED', 'FILE_AGENT_TOOLS',
  'FILE_CHECK_FAILED_PREFIX', 'FingerprintMismatchError', 'IMPORT_EMPTY', 'IMPORT_NEEDS_SITE_LOGIN', 'IMPORT_NOT_ADOPTABLE',
  'IMPORT_PROOF_FAILED', 'IMPORT_REFUSES_WRITES', 'IMPORT_UNSUPPORTED_TARGET', 'INVALID_PARAMS', 'InvalidPolicyError', 'MAC_DOMAIN',
  'MAX_AGENT_ACTIONS', 'MAX_AGENT_TOKENS', 'MAX_BUDGET_MS', 'MAX_CAPTURE_BYTES', 'MAX_EXPECTED_FILE_BYTES', 'MAX_LITERAL_LOAD',
  'MAX_LITERAL_PROPOSAL', 'MAX_RENDERED', 'MAX_ROWS', 'MAX_RUN_BINARY_BYTES', 'MAX_SCREENSHOT_HEIGHT', 'MAX_SELECT_TOTAL',
  'MAX_SELECT_VALUES', 'MAX_STEP_TIMEOUT_MS', 'MAX_TEXT_BYTES', 'MAX_TYPED', 'METHOD_NOT_FOUND', 'MIME', 'MIN_PROVE_MS', 'NO_REVIEW_DIGEST',
  'NoFreeSessionError', 'NoRunError', 'PAGINATE_MAX', 'PAGINATE_NEXT_WAIT_MS', 'PLAYWRIGHT_VERSION', 'PROTOCOL_VERSION', 'PROVE_RESERVE_MS',
  'PolicyError', 'PolicyRefusedError', 'PrivateNetworkError', 'REF_ATTR', 'RUNNER_CONNECT_TIMEOUT_MS', 'RUNNER_ERROR_CODES', 'RUNNER_PATH',
  'RunnerBusyError', 'RunnerClient', 'RunnerConnectError', 'RunnerDisconnectedError', 'RunnerError', 'RunnerTimeoutError',
  'RunnerTokenRefusedError', 'SECRET_FILL_VALUE', 'SESSION_WAIT_MS', 'SHOWN_PREFIXES', 'STEPS_HASH_MISMATCH', 'STEP_VERBS',
  'ScriptShapeError', 'SignInPolicyError', 'UNVERIFIED_COUNT_FLAG', 'USE_CASE_WORDS', 'WORKFLOW_CODE', 'WRITE_STEPS_INVALID',
  'absoluteHttpUrl', 'adoptDraft', 'agentSystemPrompt', 'binaryName', 'build', 'buildProposal', 'candidatesFor', 'candidatesOf',
  'canonicalize', 'changeListMatches', 'checkDesktopTrust', 'checkFile', 'checkRequest', 'checkTrust', 'clampBudget', 'classifyFailure',
  'codeWorkflowFailed', 'compileProposal', 'connectRunner', 'createAddressGuard', 'createMasker', 'currentIdentity', 'declareWrites',
  'defaultResolveHost', 'describeCheck', 'describeDesktopStep', 'describeInterrupt', 'describeLocator', 'describeStep', 'desktopBinding',
  'desktopProposal', 'desktopSafetyFlags', 'desktopVerbOf', 'desktopWriteCandidates', 'detectImportSource', 'detectTotal',
  'downloadTemplateIssues', 'downloadTemplateOf', 'effectivePolicy', 'effectiveWriteMode', 'elideOldPages', 'extractsFields', 'fileFacts',
  'fingerprintOf', 'firstPresent', 'firstUserMessage', 'flattenSteps', 'hasChangePassword', 'hasSecretFill', 'hasSignature', 'hostnameOf',
  'importSource', 'installInterrupts', 'isDesktopDocument', 'isDestructive', 'isEmptySteps', 'isLoginPage', 'isPrivateAddress',
  'isVisibleNow', 'laneFailure', 'laneMasker', 'localLaunchArgs', 'loginBlockEnd', 'maskLog', 'maskedName', 'matchingReadPost',
  'modelErrorText', 'msUntilNextWindow', 'needsApprovalAsWritten', 'neutralize', 'newRunState', 'noWritePolicy', 'normalizeFingerprint',
  'normalizeForDenylist', 'notHttp', 'notReplayedFlags', 'notReplayedProposal', 'openLaneRuntime', 'openSession', 'pageOf',
  'parseDesktopScript', 'parseScript', 'parseWriteSteps', 'probeRunner', 'promptVars', 'proposalDigest', 'proveScript', 'readPathMatches',
  'readPathTooBroad', 'readPostLabel', 'readPostsProblem', 'renderSnapshot', 'renderVars', 'repairKind', 'repairPrecondition',
  'requestFrame', 'resolveGoto', 'resolveUnique', 'responseText', 'reviewDesktopLocator', 'reviewLocator', 'runAgentLoop', 'runDesktopTask',
  'runSteps', 'runTask', 'runnerAddress', 'runnerConnected', 'runnerError', 'sanitizeFileName', 'screenshotMasks', 'scriptHash',
  'scrubTrace', 'settle', 'shownFailure', 'signDesktopSteps', 'signScript', 'signSteps', 'snapshot', 'sniffMime', 'startHostOf',
  'stepChanges', 'stopTrace', 'stripShownPrefix', 'substituteVars', 'toErrorCode', 'totp', 'unsignedWrites', 'validateScript', 'verbOf',
  'verifyRows', 'verifyScript', 'violationMessage', 'wantTrace',
];

describe('engine exports', () => {
  it('index.ts exports exactly the pinned runtime names', async () => {
    expect(Object.keys(await import('../src/index.js')).sort()).toEqual(EXPORTS);
  });
  it('the pinned list is sorted and has no duplicates', () => {
    expect([...EXPORTS].sort()).toEqual(EXPORTS);
    expect(new Set(EXPORTS).size).toBe(EXPORTS.length);
  });
});
