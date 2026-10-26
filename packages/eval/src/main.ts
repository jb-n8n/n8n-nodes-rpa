import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2), process.env);
