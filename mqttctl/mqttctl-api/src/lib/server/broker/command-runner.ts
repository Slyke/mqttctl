import { spawn } from 'node:child_process';
import { createAppError } from '$server/logging/errors';

export interface CommandResult {
  executable: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export const runCommand = async ({
  executable,
  args,
  displayArgs,
  timeoutMs = 10_000,
  correlationId
}: {
  executable: string;
  args: string[];
  displayArgs?: string[];
  timeoutMs?: number;
  correlationId: string | null;
}): Promise<CommandResult> => {
  const startedAt = Date.now();
  const resultArgs = displayArgs ?? args;

  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(createAppError({
        caller: 'broker::runCommand',
        reason: `Failed spawning ${executable}.`,
        errorKey: 'BROKER_COMMAND_FAILED',
        correlationId,
        context: { executable, args: resultArgs },
        cause: error
      }));
    });

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      resolve({
        executable,
        args: resultArgs,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      });
    });
  });
};
