// mcode-sessions entrypoint.
import { runCli } from './cli.js';

try {
  const code = await runCli(process.argv.slice(2));
  process.exit(typeof code === 'number' ? code : 0);
} catch (e) {
  process.stderr.write(`error: ${e?.stack || e}\n`);
  process.exit(1);
}
