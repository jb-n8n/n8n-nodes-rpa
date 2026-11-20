// Preloaded (node --import) by test/setup.test.ts: the setup command sees a terminal on piped stdin and stdout, so its
// prompts can be answered by the test. Test-only: the command itself is unchanged.
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true });
process.stdin.setRawMode = () => process.stdin;
