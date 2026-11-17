import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawnObservedClaudeProcess } from '../../../../../../packages/maker-core/src/agents/claude-code/local-process-spawn.js';
import { createStrictClaudeTools, STRICT_CLAUDE_SERVER } from '../../maker-host/strict-claude-tools.js';
import { isolatedClaudeOptions, isolatedClaudeSettings } from '../../../../../../packages/maker-core/src/agents/claude-code/tool-isolation.js';
import { validateExternalClaude } from '../external-claude.js';

const execFileAsync = promisify(execFile);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

afterEach(() => vi.unstubAllEnvs());

// Local integration: exercise the pinned SDK and Cindy's actual spawn adapter.
// Every executable/config file below is generated in an isolated temporary home;
// this test never discovers or invokes an installed Claude or a user's wrapper.
describe.skipIf(process.platform !== 'darwin')('external Claude wrapper process boundary', () => {
  it('preserves argv, cwd, proxy, preload and sandbox through native and SDK launches', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-wrapper-')));
    const home = path.join(root, 'isolated-home');
    const wrapper = path.join(root, 'wrapper with spaces');
    const cli = path.join(root, 'fake-cli.mjs');
    const preload = path.join(root, 'preload.cjs');
    const denied = path.join(root, 'sandbox-denied');
    const record = path.join(root, 'record.json');
    const toolRecord = path.join(root, 'tool-response.json');
    const profile = path.join(root, 'mock.sb');
    await fs.mkdir(home);
    await fs.writeFile(preload, "process.env.MOCK_PRELOAD = 'loaded';\n");
    await fs.writeFile(profile, `(version 1)\n(allow default)\n(deny network*)\n(deny file-write* (literal ${JSON.stringify(denied)}))\n`);
    await fs.writeFile(cli, `
import fs from 'node:fs';
import readline from 'node:readline';
let sandboxError;
try { fs.writeFileSync(${JSON.stringify(denied)}, 'must be denied'); }
catch (error) { sandboxError = error.code; }
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), sandboxError,
  env: Object.fromEntries(['HOME', 'CLAUDE_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY',
    'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
    'NODE_USE_ENV_PROXY', 'NODE_OPTIONS', 'MOCK_PRELOAD', 'CLAUDE_NETWORK_GUARD',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']
    .map(key => [key, process.env[key]]))
}));
if (process.argv.includes('--version')) { console.log('0.0.0 (Mock Claude)'); }
else if (process.argv[2] === 'auth') { console.log(JSON.stringify({loggedIn:true, authMethod:'claude.ai', subscriptionType:'pro'})); }
else {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.type === 'control_response' && message.response.request_id === 'mock-tool') {
      fs.writeFileSync(${JSON.stringify(toolRecord)}, JSON.stringify(message));
      return;
    }
    if (message.type !== 'control_request') return;
    console.log(JSON.stringify({ type: 'control_response', response: {
      subtype: 'success', request_id: message.request_id,
      response: { models: [{value:'mock-claude', displayName:'Mock Claude'}], commands: [] }
    }}));
    if (message.request.subtype === 'initialize') console.log(JSON.stringify({
      type: 'control_request', request_id: 'mock-tool', request: {
        subtype: 'mcp_message', server_name: 'cindy_restricted', message: {
          jsonrpc: '2.0', id: 99, method: 'tools/call',
          params: { name: 'write_file', arguments: { path: 'sdk-created.txt', content: 'mock worker succeeded' } }
        }
      }
    }));
  });
}
`);
    await fs.writeFile(wrapper, `#!/bin/sh
set -eu
export HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY"
export ALL_PROXY="$HTTP_PROXY" all_proxy="$HTTP_PROXY"
export NO_PROXY=127.0.0.1,localhost,::1 no_proxy=127.0.0.1,localhost,::1
export NODE_USE_ENV_PROXY=1 CLAUDE_NETWORK_GUARD=7897
export NODE_OPTIONS=${shellQuote(`--require=${preload}`)}
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
exec /usr/bin/sandbox-exec -f ${shellQuote(profile)} ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"
`, { mode: 0o755 });
    const env = {
      HOME: home, CLAUDE_CONFIG_DIR: home, PATH: '/usr/bin:/bin',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      ANTHROPIC_API_KEY: 'fake-key-must-be-removed', ANTHROPIC_AUTH_TOKEN: 'fake-token',
      ANTHROPIC_BASE_URL: 'https://invalid.example', HTTPS_PROXY: 'http://127.0.0.1:1',
    };
    let sdk: ReturnType<typeof query> | undefined;
    try {
      vi.stubEnv('CINDY_CLAUDE_EXECUTABLE', wrapper);
      const selected = await validateExternalClaude();
      expect(selected).toBe(wrapper);
      const status = await execFileAsync(selected, ['auth', 'status', '--json'], { env, cwd: home });
      expect(JSON.parse(status.stdout).loggedIn).toBe(true);
      expect(JSON.parse(await fs.readFile(record, 'utf8')).argv).toEqual(['auth', 'status', '--json']);
      const version = await execFileAsync(selected, ['--version'], { env, cwd: home });
      expect(version.stdout).toContain('Mock Claude');
      let spawnedCommand: string | undefined;
      const provider = createStrictClaudeTools([wrapper, cli, profile]);
      sdk = query({ prompt: 'mock only', options: {
        pathToClaudeCodeExecutable: selected, env, cwd: home,
        ...isolatedClaudeOptions(), settings: isolatedClaudeSettings(), persistSession: false,
        mcpServers: { [STRICT_CLAUDE_SERVER]: provider.toClaudeSdkConfig!({ agentKind: 'claude-code', workingDir: home }) as never },
        spawnClaudeCodeProcess: spawnOptions => {
          spawnedCommand = spawnOptions.command;
          return spawnObservedClaudeProcess({ spawnOptions });
        },
      } });
      await expect(sdk.supportedModels()).resolves.toEqual([{ value: 'mock-claude', displayName: 'Mock Claude' }]);
      await vi.waitFor(async () => {
        expect(await fs.readFile(path.join(home, 'sdk-created.txt'), 'utf8')).toBe('mock worker succeeded');
        expect(await fs.readFile(toolRecord, 'utf8')).toContain('OK');
      });
      expect(spawnedCommand).toBe(wrapper);
      const observed = JSON.parse(await fs.readFile(record, 'utf8'));
      expect(observed.argv).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--output-format']));
      expect(observed.cwd).toBe(home);
      expect(observed.sandboxError).toBe('EPERM');
      expect(observed.env).toEqual({
        HOME: home, CLAUDE_CONFIG_DIR: home,
        HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897',
        http_proxy: 'http://127.0.0.1:7897', https_proxy: 'http://127.0.0.1:7897',
        ALL_PROXY: 'http://127.0.0.1:7897', all_proxy: 'http://127.0.0.1:7897',
        NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
        NODE_USE_ENV_PROXY: '1', NODE_OPTIONS: `--require=${preload}`, MOCK_PRELOAD: 'loaded',
        CLAUDE_NETWORK_GUARD: '7897',
      });
    } finally {
      sdk?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
