import { promptSync } from './prompt.js';

/**
 * Everything the CLI touches in the outside process, as one injectable object: tests run `runCli` in-process with a
 * fake and assert on captured output; the real binary gets `processIo()`. `prompt` is absent when there is no TTY,
 * which is how commands know they must fail instead of waiting on a pipe. `stdoutStream` is the raw stream for bulk
 * output (`export` to stdout), so a large export is streamed with backpressure instead of buffered through `stdout()`.
 */
export interface CliIo {
  stdout(s: string): void;
  stderr(s: string): void;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  prompt?: (q: string, masked: boolean) => string;
  cwd: string;
  execPath: string;
  argv0: string;
  stdoutStream?: NodeJS.WritableStream;
}

/** The real process: the one place the CLI writes to process.stdout / process.stderr (the lint script allows console use only here). */
export function processIo(): CliIo {
  const isTTY = Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY);
  // `opencontext-vault list | head` closes our stdout early: that is the reader's choice, not an error worth a stack trace.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
  return {
    stdout: (s: string): void => {
      process.stdout.write(s);
    },
    stderr: (s: string): void => {
      process.stderr.write(s);
    },
    env: process.env,
    isTTY,
    ...(isTTY ? { prompt: (q: string, masked: boolean): string => promptSync(q, masked) } : {}),
    cwd: process.cwd(),
    execPath: process.execPath,
    argv0: process.argv0,
    stdoutStream: process.stdout,
  };
}
