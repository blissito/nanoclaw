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

import { FormmyWhatsAppChannel, extractPhone } from './formmy-whatsapp.js';

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
    null,
    null,
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

  it('strips @s.whatsapp.net from legacy JID before sending to Formmy', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const ch = makeChannel(mock.port);
    await ch.sendMessage('formmy_5217712412825@s.whatsapp.net', 'hola');
    const sent = JSON.parse(mock.requests[0].body);
    expect(sent.phone_number).toBe('5217712412825');
  });

  it('rejects on 200 with wrapped Meta error (no retry)', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Meta API error',
          details: {
            error: {
              message:
                "(#132018) There's an issue with the parameters in your template",
              code: 132018,
              type: 'OAuthException',
              error_data: {
                messaging_product: 'whatsapp',
                details: 'Either one of media ID or link must be present',
              },
              fbtrace_id: 'AfnSwB055AJnmwPdJvidqzM',
            },
          },
        }),
      );
    });
    const ch = makeChannel(mock.port);
    await expect(ch.sendMessage('formmy_5215555', 'hola')).rejects.toThrow(
      /132018/,
    );
    // Non-retryable: only one attempt
    expect(mock.requests).toHaveLength(1);
  });

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

describe('FormmyWhatsAppChannel rich message types', () => {
  let mock: MockServerHandle | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
  });

  it('sendReaction posts type:reaction with message_id + emoji', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const ch = makeChannel(mock.port);
    await ch.sendReaction('formmy_5215555', 'wamid.ABC', '👀');
    const sent = JSON.parse(mock.requests[0].body);
    expect(sent.type).toBe('reaction');
    expect(sent.message_id).toBe('wamid.ABC');
    expect(sent.emoji).toBe('👀');
  });

  it('markRead posts type:read with message_id and typing flag', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const ch = makeChannel(mock.port);
    await ch.markRead('formmy_5215555', 'wamid.XYZ', true);
    const sent = JSON.parse(mock.requests[0].body);
    expect(sent.type).toBe('read');
    expect(sent.message_id).toBe('wamid.XYZ');
    expect(sent.typing).toBe(true);
  });

  it('sendCtaUrl posts type:interactive with url + button_text', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const ch = makeChannel(mock.port);
    await ch.sendCtaUrl(
      'formmy_5215555',
      '¿Agendamos?',
      'https://cal.com/demo',
      'Agendar',
    );
    const sent = JSON.parse(mock.requests[0].body);
    expect(sent.type).toBe('interactive');
    expect(sent.text).toBe('¿Agendamos?');
    expect(sent.url).toBe('https://cal.com/demo');
    expect(sent.button_text).toBe('Agendar');
  });

  it('sendContact posts type:contacts with Meta contact shape', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const ch = makeChannel(mock.port);
    await ch.sendContact('formmy_5215555', 'Soporte', '+5215512345678');
    const sent = JSON.parse(mock.requests[0].body);
    expect(sent.type).toBe('contacts');
    expect(sent.contacts[0].name.formatted_name).toBe('Soporte');
    expect(sent.contacts[0].phones[0].phone).toBe('+5215512345678');
    expect(sent.contacts[0].phones[0].wa_id).toBe('5215512345678');
  });
});

describe('extractPhone', () => {
  it('strips formmy_ prefix and @s.whatsapp.net suffix (legacy JID)', () => {
    expect(extractPhone('formmy_5217712412825@s.whatsapp.net')).toBe(
      '5217712412825',
    );
  });

  it('strips @c.us suffix', () => {
    expect(extractPhone('formmy_5217712412825@c.us')).toBe('5217712412825');
  });

  it('returns plain phone for legacy JID without suffix', () => {
    expect(extractPhone('formmy_5215555')).toBe('5215555');
  });

  it('parses new formmy_<integrationId>_<phone> format', () => {
    expect(extractPhone('formmy_6a022c27c5f337665dbf3151_5217712412825')).toBe(
      '5217712412825',
    );
  });

  it('parses new format even with @s.whatsapp.net suffix appended', () => {
    expect(
      extractPhone(
        'formmy_6a022c27c5f337665dbf3151_5217712412825@s.whatsapp.net',
      ),
    ).toBe('5217712412825');
  });
});
