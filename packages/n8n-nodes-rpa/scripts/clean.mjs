// Empties dist before a build, so compiled files of deleted sources (for example removed credentials) never ship.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

rmSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'), { recursive: true, force: true });
