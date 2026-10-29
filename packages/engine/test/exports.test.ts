import { describe, expect, it } from 'vitest';

/**
 * The engine's runtime exports, pinned. A task that adds or removes an export updates this
 * list in the same commit. Type-only exports (interfaces, types) do not exist at runtime and are not listed.
 */
const EXPORTS = [
  'AGENT_SIGN_IN_UNFINISHED', 'AGENT_TOOLS', 'ALSO_CHANGED', 'AgentTools', 'BLOCKED_REQUEST', 'BLOCKED_STOP', 'BROWSER_ERROR_PAGE',
  'BROWSER_STEPS_NEED_BROWSER', 'BrowserUnavailableError', 'CANCELLED', 'CHROMIUM_MISSING', 'COMPILE_CHANGES_FILE_CHECK',
  'COMPILE_EMITS_SUBMIT', 'COMPILE_TOUCHES_SUBMIT', 'CONNECT_TIMEOUT_MS', 'CompileError', 'DEFAULT_BUDGET_MS', 'DEFAULT_BUSY_WAIT_MS',
  'DEFAULT_LEASE_MS', 'DEFAULT_MAX_ACTIONS', 'DEFAULT_MAX_BYTES', 'DEFAULT_MAX_TOKENS', 'DEFAULT_MIME', 'DEFAULT_RUNNER_PORT', 'DENYLIST',
  'DESKTOP_CHANGES_MISMATCH', 'DESKTOP_EVIDENCE_INVALID', 'DESKTOP_FLAGS_INCOMPLETE', 'DESKTOP_NEEDS_FIRST_VERSION',
  'DESKTOP_STEPS_NEED_RUNNER', 'DESKTOP_UNSIGNED_WRITES', 'DESKTOP_VERBS', 'DETECTED_PREFIX', 'DOWNLOAD_NEEDS_BROWSER_SERVER',
  'DesktopUnavailableError', 'ENDPOINT_NOT_SECURE', 'EXPORT_DIR_TOKEN', 'EXTRACT_FIELDS_DROPPED', 'ElementCannotActError',
  'ElementNotFoundError', 'ElementNotUniqueError', 'ExpectedFileMissingError', 'FIELDS_UNSUPPORTED', 'FILE_AGENT_TOOLS',
  'FILE_CHECK_FAILED_PREFIX', 'FILE_NOT_DELIVERABLE', 'FILE_WITHHELD', 'FIRST_RUN_NEEDS_NAME', 'FIRST_RUN_NEEDS_TARGET', 'FIRST_STEP_GOTO',
  'FRAME_NOT_CHECKED', 'FingerprintMismatchError', 'IMPORT_EMPTY', 'IMPORT_NEEDS_SITE_LOGIN', 'IMPORT_NOT_ADOPTABLE',
  'IMPORT_PROOF_FAILED', 'IMPORT_REFUSES_WRITES', 'IMPORT_UNSUPPORTED_TARGET', 'INPUT_CONTAINS_SECRET', 'INVALID_PARAMS',
  'InvalidPolicyError', 'LOOKS_DESTRUCTIVE', 'MAC_DOMAIN', 'MAX_AGENT_ACTIONS', 'MAX_AGENT_TOKENS', 'MAX_BUDGET_MS', 'MAX_CAPTURE_BYTES',
  'MAX_EXPECTED_FILE_BYTES', 'MAX_LITERAL_LOAD', 'MAX_LITERAL_PROPOSAL', 'MAX_RENDERED', 'MAX_ROWS', 'MAX_RUN_BINARY_BYTES',
  'MAX_SCREENSHOT_HEIGHT', 'MAX_TEXT_BYTES', 'MAX_TYPED', 'MIME', 'MIN_PROVE_MS', 'NOT_A_TABLE', 'NO_REVIEW_DIGEST', 'NO_STEPS_NO_REPAIR',
  'NO_TOTP_SECRET', 'NoFreeSessionError', 'NoRunError', 'PAGE_SHOWS_CREDENTIAL', 'PAGINATE_MAX', 'PAGINATE_NEXT_WAIT_MS',
  'PASSWORD_FILL_REFUSED', 'PASSWORD_FILL_REFUSED_STEPS', 'PDF_NEEDS_HEADLESS', 'PDF_TIMED_OUT', 'PLAYWRIGHT_VERSION', 'PROTOCOL_VERSION',
  'PROVE_RESERVE_MS', 'PolicyError', 'PolicyRefusedError', 'PrivateNetworkError', 'REF_ATTR', 'REPAIR_ALREADY_RAN',
  'REPAIR_DOWNLOAD_NEEDS_CHECK', 'REPAIR_NEEDS_ID_AND_EXTRACT', 'REPAIR_NO_CAPTURES', 'REPAIR_ONE_DOWNLOAD', 'REPAIR_REFUSED_WRITES',
  'REPAIR_SIGN_IN_HALF_DONE', 'ROWS_WITHHELD', 'RUNNER_BUSY', 'RUNNER_CONNECT_TIMEOUT_MS', 'RUNNER_DISCONNECTED', 'RUNNER_ERROR_CODES',
  'RUNNER_FINGERPRINT_INVALID', 'RUNNER_PATH', 'RUNNER_URL_HAS_CREDENTIALS', 'RUNNER_URL_NOT_SECURE', 'RunnerBusyError', 'RunnerClient',
  'RunnerConnectError', 'RunnerDisconnectedError', 'RunnerError', 'RunnerTimeoutError', 'RunnerTokenRefusedError', 'SESSION_WAIT_MS',
  'SHOWN_PREFIXES', 'SIGNATURE_INVALID', 'SIGNATURE_WITHOUT_KEY', 'SIGNIN_NEEDS_SITE_LOGIN', 'SIGNIN_NEXT_NO_PASSWORD',
  'STEPS_CHANGED_AFTER_REVIEW', 'STEPS_HASH_MISMATCH', 'STEPS_NAME_MISMATCH', 'STEPS_VERSION_MISMATCH', 'STEP_VERBS', 'ScriptShapeError',
  'SignInPolicyError', 'UNSIGNED_REQUIRED', 'UNSIGNED_WRITES', 'UNVERIFIED_COUNT_FLAG', 'USE_CASE_WORDS', 'WINDOW_STEP_NOT_CLICK',
  'WRITE_STEPS_INVALID', 'absoluteHttpUrl', 'adoptDraft', 'agentSignInLocked', 'agentSignInRejected', 'agentSystemPrompt', 'binaryName',
  'browserLocatorOnDesktop', 'browserStepOnDesktop', 'browserUnreachable', 'browserVersionMismatch', 'build', 'buildProposal',
  'candidatesFor', 'candidatesOf', 'canonicalize', 'captureTooLarge', 'changeListMatches', 'checkDesktopTrust', 'checkFile',
  'checkRequest', 'checkTrust', 'clampBudget', 'classifyFailure', 'compileProposal', 'connectRunner', 'countMismatch',
  'createAddressGuard', 'createMasker', 'currentIdentity', 'declareWrites', 'defaultResolveHost', 'describeCheck', 'describeDesktopStep',
  'describeForUser', 'describeInterrupt', 'describeLocator', 'describeStep', 'desktopBinding', 'desktopLocatorInBrowser',
  'desktopNotInteractive', 'desktopProposal', 'desktopSafetyFlags', 'desktopVerbOf', 'desktopWriteCandidates', 'detectTotal',
  'downloadTemplateIssues', 'downloadTemplateOf', 'effectivePolicy', 'effectiveWriteMode', 'elementTooTall', 'elideOldPages',
  'expectedFileInvalid', 'exportDirOnlyInFill', 'extractsFields', 'fileFacts', 'fingerprintOf', 'firstPresent', 'firstUserMessage',
  'flattenSteps', 'formPostsElsewhere', 'hasSignature', 'hostnameOf', 'importSource', 'inputTooLong', 'installInterrupts',
  'isDesktopDocument', 'isDestructive', 'isEmptySteps', 'isLoginPage', 'isPrivateAddress', 'isVisibleNow', 'laneFailure', 'laneMasker',
  'localLaunchArgs', 'locatorNotFound', 'locatorNotUnique', 'loginBlockEnd', 'maskLog', 'maskedName', 'matchingReadPost', 'modelErrorText',
  'msUntilNextWindow', 'nameMismatch', 'neutralize', 'newRunState', 'noFreeBrowserSession', 'noWritePolicy', 'normalizeFingerprint',
  'normalizeForDenylist', 'notHttp', 'notLoaded', 'notReachedNetworkIdle', 'offListSite', 'openLaneRuntime', 'openSession', 'pageOf',
  'parseDesktopScript', 'parseScript', 'parseWriteSteps', 'privateAddress', 'probeRunner', 'promptVars', 'proposalDigest', 'proveScript',
  'readPathMatches', 'readPathTooBroad', 'readPostLabel', 'readPostsProblem', 'renderSnapshot', 'renderVars', 'renderedTooLong',
  'repairKind', 'repairPrecondition', 'requestFrame', 'reservedTemplate', 'resolveGoto', 'resolveUnique', 'responseText',
  'reviewDesktopLocator', 'reviewLocator', 'rowTextTooLarge', 'runAgentLoop', 'runBinaryTooLarge', 'runDesktopTask', 'runSteps', 'runTask',
  'runnerAddress', 'runnerAppMissing', 'runnerConnected', 'runnerError', 'runnerFingerprintMismatch', 'runnerTokenRefused',
  'runnerUnreachable', 'sanitizeFileName', 'screenshotMasks', 'screenshotTooTall', 'scriptHash', 'scrubTrace', 'secretInLocation',
  'settle', 'shownFailure', 'signDesktopSteps', 'signScript', 'signSteps', 'snapshot', 'sniffMime', 'startHostOf', 'startSiteMismatch',
  'stepChanges', 'stopTrace', 'stripShownPrefix', 'substituteVars', 'toErrorCode', 'tokenRefused', 'tooManyRows', 'totp', 'unsignedWrites',
  'validateScript', 'verbOf', 'verifyRows', 'verifyScript', 'versionMismatch', 'violationMessage', 'wantTrace',
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
