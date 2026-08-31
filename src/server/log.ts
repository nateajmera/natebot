const DEBUG = process.env.NATEBOT_DEBUG === "1";

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  info(msg: string): void {
    process.stdout.write(`  ${msg}\n`);
  },
  step(msg: string): void {
    process.stdout.write(`  ${msg}\n`);
  },
  warn(msg: string): void {
    process.stderr.write(`  ! ${msg}\n`);
  },
  error(msg: string): void {
    process.stderr.write(`  ✗ ${msg}\n`);
  },
  debug(msg: string): void {
    if (DEBUG) process.stderr.write(`  [${stamp()}] ${msg}\n`);
  },
};
