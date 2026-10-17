// Entry point: `node --disable-warning=ExperimentalWarning --import tsx src/bin.ts <serve|demo>`.
// (The flag hides node:sqlite's ExperimentalWarning on Node 22.)
import { main } from './cli';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
