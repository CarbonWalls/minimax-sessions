// mcode-sessions entrypoint.
import { runCli } from './cli.js';

const code = await runCli(process.argv.slice(2));
if (typeof code === 'number') process.exit(code);
process.exit(0);
