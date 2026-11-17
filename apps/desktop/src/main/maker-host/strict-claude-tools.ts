import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpProvider } from '@cindy/maker-core';
import worker from './strict-claude-worker.pl?raw';

const PROXY = 'http://127.0.0.1:7897';
const OUTPUT_LIMIT = 2 * 1024 * 1024;
export const STRICT_CLAUDE_SERVER = 'cindy_restricted';
export const STRICT_CLAUDE_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_files', 'command', 'web_fetch'] as const;
export const STRICT_CLAUDE_TOOL_NAMES = STRICT_CLAUDE_TOOLS.map(name => `mcp__${STRICT_CLAUDE_SERVER}__${name}`);
export type StrictClaudeTool = typeof STRICT_CLAUDE_TOOLS[number];

function quote(value: string): string {
  // Seatbelt strings are not shell strings. Reject control characters rather than
  // relying on JSON escapes that Seatbelt may interpret differently.
  if ([...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Unsupported sandbox path');
  return JSON.stringify(value);
}

/** The additional policy belongs to Cindy, never to the user's Claude wrapper. */
export function strictClaudeToolProfile(root: string, temporary: string, protectedPaths: readonly string[]): string {
  return `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote tcp "localhost:7897"))
(deny mach*)
(deny ipc-posix*)
(deny appleevent-send)
(deny signal (target others))
(deny file-write*)
(allow file-write* (subpath ${quote(root)}) (subpath ${quote(temporary)}) (literal "/dev/null"))
(deny file-write* (regex #"/\\.(git|claude|codex|cindy)(/|$)"))
${protectedPaths.map(p => `(deny file-write* (subpath ${quote(p)}))`).join('\n')}
`;
}

export interface StrictToolRunnerOptions {
  workingDir: string;
  /** Runtime files are never writable, even when the task owns their parent. */
  protectedPaths: readonly string[];
  signal?: AbortSignal;
}

/** One request per process; no shared interpreter or open network control socket. */
export async function runStrictClaudeTool(
  options: StrictToolRunnerOptions, tool: StrictClaudeTool, args: Record<string, unknown>,
): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('Strict Claude tools require macOS');
  if (!STRICT_CLAUDE_TOOLS.includes(tool)) throw new Error('Tool unavailable in strict Claude mode');
  options.signal?.throwIfAborted();
  const root = await fs.realpath(options.workingDir);
  const home = await fs.realpath(os.homedir());
  // A home/filesystem-wide writable grant would let a command arrange execution
  // outside the sandbox on the next login or application restart.
  if (root === path.parse(root).root || home === root || home.startsWith(`${root}${path.sep}`)) {
    throw new Error('Strict Claude tools require a project directory below the home/filesystem root');
  }
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-strict-tools-')));
  try {
    const protectedPaths = [
      ...['.claude', '.local', '.codex', '.config', '.ssh', 'Library'].map(p => path.join(home, p)),
      ...options.protectedPaths,
    ];
    const profile = strictClaudeToolProfile(root, temporary, protectedPaths);
    const env: NodeJS.ProcessEnv = {
      HOME: temporary, TMPDIR: temporary, LANG: 'en_US.UTF-8',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',
      HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, ALL_PROXY: PROXY,
      http_proxy: PROXY, https_proxy: PROXY, all_proxy: PROXY,
      NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1',
    };
    return await new Promise<string>((resolve, reject) => {
      // There is intentionally no unsandboxed fallback or inherited environment.
      const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/perl', '-e', worker], {
        cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let failure: Error | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
      };
      const aborted = () => stop(new Error('Strict tool cancelled'));
      const timer = setTimeout(() => stop(new Error('Strict tool timed out')), 60_000);
      options.signal?.addEventListener('abort', aborted, { once: true });
      if (options.signal?.aborted) aborted();
      const collect = (chunk: Buffer) => {
        size += chunk.length;
        if (size > OUTPUT_LIMIT) stop(new Error('Strict tool output limit exceeded'));
        else chunks.push(chunk);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.stdin.on('error', () => { /* The exit status below owns the failure. */ });
      child.on('error', error => { failure ??= error; });
      child.on('close', code => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', aborted);
        // A command may background children. They must not outlive this request.
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
        const output = Buffer.concat(chunks).toString('utf8');
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Strict tool failed (${code}): ${output.slice(0, 8192)}`));
        else resolve(output);
      });
      child.stdin.end(JSON.stringify({ tool, args, root }));
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/** Only this provider is registered for an isolated Claude session. */
export function createStrictClaudeTools(protectedPaths: readonly string[]): McpProvider {
  return {
    name: STRICT_CLAUDE_SERVER,
    toClaudeSdkConfig(context) {
      if (context.agentKind !== 'claude-code' || !context.workingDir) throw new Error('Strict tool context missing');
      const server = new McpServer({ name: STRICT_CLAUDE_SERVER, version: '1.0.0' });
      const schemas: Record<StrictClaudeTool, z.ZodRawShape> = {
        read_file: { path: z.string(), },
        write_file: { path: z.string(), content: z.string().max(1024 * 1024) },
        edit_file: { path: z.string(), old_text: z.string().min(1), new_text: z.string() },
        list_files: { path: z.string().default('.') },
        command: { command: z.string().max(64 * 1024) },
        web_fetch: { url: z.string().url() },
      };
      const descriptions = {
        read_file: 'Read a UTF-8 file inside the task directory (maximum 1 MiB).',
        write_file: 'Write a UTF-8 file inside the task directory; parent directory must exist.',
        edit_file: 'Replace one unique exact text occurrence in a task file.',
        list_files: 'List immediate entries of a task directory.',
        command: 'Run a shell command in the task directory, for at most 60 seconds. Network only via proxy 7897; no background services or desktop automation; personal configuration is not injected.',
        web_fetch: 'Fetch an HTTP(S) URL through proxy 7897. Returns response body, at most 1 MiB. Does not follow redirects; fetch a redirect target separately.',
      };
      for (const name of STRICT_CLAUDE_TOOLS) {
        server.tool(name, descriptions[name], schemas[name], async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => {
          try {
            const text = await runStrictClaudeTool({ workingDir: context.workingDir, protectedPaths, signal: extra.signal }, name, args);
            return { content: [{ type: 'text' as const, text }] };
          } catch (error) {
            return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Strict tool failed' }] };
          }
        });
      }
      return { type: 'sdk', name: STRICT_CLAUDE_SERVER, instance: server };
    },
  };
}
