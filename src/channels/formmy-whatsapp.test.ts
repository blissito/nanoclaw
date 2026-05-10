import http from 'http';
import type { AddressInfo } from 'net';

import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  getFormmyGroupFolder: () => null,
  getFormmyIntegrationId: () => null,
  registerFormmyUserGroup: () => {},
  setFormmyJidMapping: () => {},
}));

vi.mock('../config.js', () => ({
  FORMMY_PUBLIC_TEMPLATE: { profile: 'public' },
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
}));

import { FormmyWhatsAppChannel } from './formmy-whatsapp.js';

interface MockServerHandle {
  server: http.Server;
  port: number;
  requests: Array<{
    body: string;
    headers: http.IncomingHttpHeaders;
    socketReused: boolean;
  }>;
  close: () => Promise<void>;
}

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  callCount: number,
) => void | Promise<void>;

async function startMockServer(handler: Handler): Promise<MockServerHandle> {
  const requests: MockServerHandle['requests'] = [];
  let callCount = 0;

  const server = http.createServer(async (req, res) => {
    callCount++;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      requests.push({
        body,
        headers: req.headers,
        socketReused: req.socket.bytesRead - body.length > 0 ? true : false,
      });
      await handler(req, res, callCount);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    requests,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function makeChannel(port: number): FormmyWhatsAppChannel {
  return new FormmyWhatsAppChannel(
    {
      onMessage: async () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    },
    0,
    'test-secret',
    `http://127.0.0.1:${port}/send`,
    'test-integration',
  );
}

describe('FormmyWhatsAppChannel.postToFormmy', () => {
  let mock: MockServerHandle | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
  });

  it('resolves on 200 with a single request', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const ch = makeChannel(mock.port);
    await expect(
      ch.sendMessage('formmy_5215555', 'hola'),
    ).resolves.toBeUndefined();
    expect(mock.requests).toHaveLength(1);
    const sent = JSON.parse(mock.requests[0].body);
    expect(sent.text).toBe('hola');
    expect(sent.phone_number).toBe('5215555');
    expect(mock.requests[0].headers.authorization).toBe('Bearer test-secret');
  });

  it('fails fast on 400 without retry', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(400);
      res.end();
    });
    const ch = makeChannel(mock.port);
    await expect(ch.sendMessage('formmy_5215555', 'hola')).rejects.toThrow(
      /400/,
    );
    expect(mock.requests).toHaveLength(1);
  });

  it('fails fast on 401 without retry', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    const ch = makeChannel(mock.port);
    await expect(ch.sendMessage('formmy_5215555', 'hola')).rejects.toThrow(
      /401/,
    );
    expect(mock.requests).toHaveLength(1);
  });

  it('retries on 5xx and succeeds when server recovers', async () => {
    mock = await startMockServer((_req, res, n) => {
      if (n < 3) {
        res.writeHead(503);
        res.end();
      } else {
        res.writeHead(200);
        res.end();
      }
    });
    const ch = makeChannel(mock.port);
    await expect(
      ch.sendMessage('formmy_5215555', 'hola'),
    ).resolves.toBeUndefined();
    expect(mock.requests).toHaveLength(3);
  }, 15_000);

  it('exhausts retries on 5xx and rejects', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const ch = makeChannel(mock.port);
    await expect(ch.sendMessage('formmy_5215555', 'hola')).rejects.toThrow(
      /503/,
    );
    expect(mock.requests).toHaveLength(3);
  }, 15_000);

  it('retries on 429', async () => {
    mock = await startMockServer((_req, res, n) => {
      if (n === 1) {
        res.writeHead(429);
        res.end();
      } else {
        res.writeHead(200);
        res.end();
      }
    });
    const ch = makeChannel(mock.port);
    await expect(
      ch.sendMessage('formmy_5215555', 'hola'),
    ).resolves.toBeUndefined();
    expect(mock.requests).toHaveLength(2);
  }, 10_000);

  it('retries on socket destroy', async () => {
    mock = await startMockServer((req, res, n) => {
      if (n === 1) {
        req.socket.destroy();
      } else {
        res.writeHead(200);
        res.end();
      }
    });
    const ch = makeChannel(mock.port);
    await expect(
      ch.sendMessage('formmy_5215555', 'hola'),
    ).resolves.toBeUndefined();
    expect(mock.requests).toHaveLength(2);
  }, 10_000);

  it('reuses keep-alive sockets across back-to-back calls', async () => {
    const remoteSockets = new Set<string>();
    mock = await startMockServer((req, res) => {
      remoteSockets.add(`${req.socket.remoteAddress}:${req.socket.remotePort}`);
      res.writeHead(200);
      res.end();
    });
    const ch = makeChannel(mock.port);
    await ch.sendMessage('formmy_5215555', 'msg1');
    await ch.sendMessage('formmy_5215555', 'msg2');
    await ch.sendMessage('formmy_5215555', 'msg3');
    expect(mock.requests).toHaveLength(3);
    // All three requests should have originated from the same client socket
    // (one entry in the set), proving keep-alive reuse.
    expect(remoteSockets.size).toBe(1);
  });
});
