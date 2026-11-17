import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({ denyProxy: false, mockProxyPort: 0, caFile: '' }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn((command, argv, options) => {
    // Simulate an unavailable proxy without stopping/changing the user's proxy.
    const args = [...argv];
    if (fault.denyProxy && command === '/usr/bin/sandbox-exec') {
      args[1] += '\n(deny network-outbound (remote tcp "localhost:7897"))';
    }
    if (fault.mockProxyPort && command === '/usr/bin/sandbox-exec') {
      // Test-only socket address translation: never send a fixture through the
      // user's real 7897 listener. Assert the production boundary before mapping.
      expect(args[1]).toContain('(remote tcp "localhost:7897")');
      expect(args[4]).toContain('http://127.0.0.1:7897');
      args[1] = args[1].replaceAll('localhost:7897', `localhost:${fault.mockProxyPort}`);
      args[4] = args[4].replaceAll('http://127.0.0.1:7897', `http://127.0.0.1:${fault.mockProxyPort}`);
    }
    return actual.spawn(command, args, fault.caFile ? { ...options, env: { ...options.env, CURL_CA_BUNDLE: fault.caFile } } : options);
  }) };
});
import { runStrictClaudeTool } from '../strict-claude-tools.js';

// Integration contract: the production runner must deny direct sockets and
// writes outside its grant, even for shell grandchildren with proxy env removed.
// The prior wrapper test does not cover host tools. Uses no Claude executable.
const roots: string[] = [];
afterEach(async () => {
  fault.denyProxy = false;
  fault.mockProxyPort = 0;
  fault.caFile = '';
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-strict-test-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const project = path.join(home, 'project');
  await fs.mkdir(project, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const options = { workingDir: project, protectedPaths: [path.join(project, 'protected')] };
  return { root, home, project, options };
}

describe.skipIf(process.platform !== 'darwin')('strict Claude host tool sandbox', () => {
  it('supports file operations and commands while preserving protected/outside files', async () => {
    const f = await fixture();
    await expect(runStrictClaudeTool(f.options, 'write_file', { path: 'a.txt', content: 'first' })).resolves.toContain('OK');
    await expect(runStrictClaudeTool(f.options, 'edit_file', { path: 'a.txt', old_text: 'first', new_text: 'second' })).resolves.toContain('OK');
    await expect(runStrictClaudeTool(f.options, 'read_file', { path: 'a.txt' })).resolves.toBe('second');
    await runStrictClaudeTool(f.options, 'write_file', { path: '中文.txt', content: '中文内容' });
    await expect(runStrictClaudeTool(f.options, 'read_file', { path: '中文.txt' })).resolves.toBe('中文内容');
    await expect(runStrictClaudeTool(f.options, 'list_files', { path: '.' })).resolves.toContain('中文.txt');
    await expect(runStrictClaudeTool(f.options, 'list_files', { path: '.' })).resolves.toContain('a.txt');
    await expect(runStrictClaudeTool(f.options, 'command', { command: 'printf "$HTTPS_PROXY|$NO_PROXY"' })).resolves.toBe('http://127.0.0.1:7897|');
    await fs.writeFile(path.join(f.project, 'protected'), 'unchanged');
    await expect(runStrictClaudeTool(f.options, 'command', { command: 'echo changed > protected' })).rejects.toThrow();
    await expect(runStrictClaudeTool(f.options, 'command', { command: 'echo changed > ../escape' })).rejects.toThrow();
    await fs.symlink(f.home, path.join(f.project, 'outside'));
    await expect(runStrictClaudeTool(f.options, 'write_file', { path: 'outside/escape', content: 'bad' })).rejects.toThrow();
    expect(await fs.readFile(path.join(f.project, 'protected'), 'utf8')).toBe('unchanged');
    await fs.mkdir(path.join(f.project, '.git'));
    await expect(runStrictClaudeTool(f.options, 'command', { command: 'echo bad > .git/config' })).rejects.toThrow();
    await fs.writeFile(path.join(f.home, 'outside-data'), 'unchanged');
    await expect(runStrictClaudeTool(f.options, 'command', { command: 'ln ../outside-data alias && echo bad > alias' })).rejects.toThrow();
    expect(await fs.readFile(path.join(f.home, 'outside-data'), 'utf8')).toBe('unchanged');
  });

  it('denies direct IPv4, IPv6, UDP and loopback sockets in descendants', async () => {
    const f = await fixture();
    const command = `/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/perl -MSocket -e '
      for my $case ([AF_INET, SOCK_STREAM, "192.0.2.1", 443], [AF_INET, SOCK_STREAM, "127.0.0.1", 18800], [AF_INET6, SOCK_STREAM, "2001:db8::1", 443], [AF_INET, SOCK_DGRAM, "192.0.2.1", 53]) {
        my ($family,$type,$ip,$port)=@$case;
        if (!socket(my $s,$family,$type,0)) { die "unexpected socket error: $!" unless $!{EPERM} || $!{EACCES}; next; }
        socket(my $s,$family,$type,0) or die;
        my $address=$family==AF_INET ? sockaddr_in($port,inet_aton($ip)) : Socket::sockaddr_in6($port,Socket::inet_pton(AF_INET6,$ip));
        die "DIRECT CONNECT SUCCEEDED" if connect($s,$address);
        die "unexpected connect error: $!" unless $!{EPERM} || $!{EACCES};
      }
      print "all denied";
    '`;
    await expect(runStrictClaudeTool(f.options, 'command', { command })).resolves.toContain('all denied');
  });

  it('fails closed when 7897 is unavailable without reaching a reachable direct target', async () => {
    const f = await fixture();
    let requests = 0;
    const server = http.createServer((_req, res) => { requests++; res.end('DIRECT LEAK'); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      fault.denyProxy = true;
      const address = server.address() as { port: number };
      await expect(runStrictClaudeTool(f.options, 'web_fetch', { url: `http://127.0.0.1:${address.port}/fixture` })).rejects.toThrow();
      expect(requests).toBe(0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('fetches through a mock 7897 proxy without contacting the URL destination', async () => {
    const f = await fixture();
    const requests: string[] = [];
    const proxy = http.createServer((req, res) => { requests.push(req.url!); res.end('MOCK PROXY RESPONSE'); });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    fault.mockProxyPort = (proxy.address() as { port: number }).port;
    try {
      await expect(runStrictClaudeTool(f.options, 'web_fetch', { url: 'http://fixture.invalid/offline' })).resolves.toContain('MOCK PROXY RESPONSE');
      expect(requests).toEqual(['http://fixture.invalid/offline']);
    } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
  });

  it('verifies HTTPS certificates through a mock CONNECT proxy', async () => {
    const f = await fixture();
    const key = path.join(f.root, 'key.pem'), cert = path.join(f.root, 'cert.pem');
    await promisify(execFile)('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fixture.invalid', '-keyout', key, '-out', cert]);
    const target = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (_req, res) => res.end('MOCK TLS RESPONSE'));
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    const proxy = http.createServer();
    const sockets = new Set<{ destroy(): unknown }>();
    const connects: string[] = [];
    proxy.on('connect', (req, client, head) => {
      connects.push(req.url!);
      const upstream = net.connect((target.address() as { port: number }).port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      sockets.add(client); sockets.add(upstream);
      client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    fault.mockProxyPort = (proxy.address() as { port: number }).port;
    fault.caFile = cert;
    try {
      await expect(runStrictClaudeTool(f.options, 'web_fetch', { url: 'https://fixture.invalid/offline' })).resolves.toContain('MOCK TLS RESPONSE');
      expect(connects).toEqual(['fixture.invalid:443']);
      await expect(runStrictClaudeTool(f.options, 'web_fetch', { url: 'https://wrong.invalid/offline' })).rejects.toThrow();
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
    }
  });

  it('cannot delegate to LaunchServices and refuses invalid scopes/tools', async () => {
    const f = await fixture();
    await expect(runStrictClaudeTool(f.options, 'command', { command: '/usr/bin/osascript -e \'tell application "System Events" to count processes\'' })).rejects.toThrow();
    await expect(runStrictClaudeTool({ ...f.options, workingDir: f.home }, 'command', { command: 'true' })).rejects.toThrow('project directory');
    await expect(runStrictClaudeTool(f.options, 'browser' as never, {})).rejects.toThrow('unavailable');
  });
});
