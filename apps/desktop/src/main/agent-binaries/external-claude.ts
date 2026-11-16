import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { AuthAdapterOptions } from '@cindy/maker-core';

/** Explicit, process-local selection. Never resolve the wrapper's target or fall back. */
export function externalClaudePath(): string | undefined {
  const value = process.env.CINDY_CLAUDE_EXECUTABLE;
  if (value === undefined) return undefined;
  if (process.platform !== 'darwin' || !value.trim() || !path.isAbsolute(value)) {
    throw new Error('CINDY_CLAUDE_EXECUTABLE requires an absolute executable path on macOS');
  }
  return value;
}

export function hasExternalClaude(): boolean {
  return process.env.CINDY_CLAUDE_EXECUTABLE !== undefined;
}

export async function validateExternalClaude(): Promise<string> {
  const executable = externalClaudePath();
  if (!executable) throw new Error('External Claude executable is not configured');
  if (!(await stat(executable)).isFile()) throw new Error('External Claude executable must be a file');
  await access(executable, constants.X_OK);
  return executable;
}

/** This integration preserves wrappers that deliberately remove gateway credentials. */
export function assertExternalClaudeSubscription(options?: AuthAdapterOptions, servesModel = true): void {
  if (!hasExternalClaude()) return;
  if (!servesModel || (options?.credentialMode && options.credentialMode !== 'oauth-bearer')
    || (options?.providerId && options.providerId !== 'anthropic')
    || (options?.nativeSubscriptionAccount && !options.nativeSubscriptionAccount.defaultProfile)) {
    throw new Error('External Claude wrapper supports only the default local Claude subscription; gateway and other provider routes are unavailable');
  }
}
