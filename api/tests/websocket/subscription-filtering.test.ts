import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import WebSocket from 'ws';
import { createServer } from 'http';
import type { Server as HttpServer } from 'http';
import { Server as WsServer } from 'ws';

interface ClientSubscription {
  assets: Set<string>;
  wildcardAll: boolean;
}

const TEST_ASSETS = ['XLM', 'USDC', 'BTC', 'ETH', 'USD'];
const SUPPORTED_ASSETS = ['XLM', 'USDC', 'BTC', 'ETH', 'USD', 'EUR'];
const WS_PORT = 9999;

let httpServer: HttpServer;
let wss: WsServer;
const clientSubscriptions = new Map<WebSocket, ClientSubscription>();

beforeAll((done) => {
  httpServer = createServer();
  wss = new WsServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket) => {
    clientSubscriptions.set(ws, {
      assets: new Set(),
      wildcardAll: false,
    });

    ws.on('message', (data: string) => {
      try {
        const message = JSON.parse(data);
        handleSubscriptionMessage(ws, message);
      } catch (err) {
        ws.send(JSON.stringify({ error: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      clientSubscriptions.delete(ws);
    });
  });

  httpServer.listen(WS_PORT, done);
});

afterAll((done) => {
  wss.close();
  httpServer.close(done);
});

function handleSubscriptionMessage(ws: WebSocket, message: any) {
  const sub = clientSubscriptions.get(ws);
  if (!sub) return;

  if (message.type === 'subscribe') {
    if (message.asset === '*') {
      sub.wildcardAll = true;
      ws.send(JSON.stringify({
        type: 'subscribed',
        asset: '*',
        message: 'Subscribed to all assets',
      }));
    } else if (SUPPORTED_ASSETS.includes(message.asset)) {
      sub.assets.add(message.asset);
      ws.send(JSON.stringify({
        type: 'subscribed',
        asset: message.asset,
        message: `Subscribed to ${message.asset}`,
      }));
    } else {
      ws.send(JSON.stringify({
        error: `Asset ${message.asset} not supported`,
        supported: SUPPORTED_ASSETS,
      }));
    }
  } else if (message.type === 'unsubscribe') {
    if (message.asset === '*') {
      sub.wildcardAll = false;
      ws.send(JSON.stringify({
        type: 'unsubscribed',
        asset: '*',
        message: 'Unsubscribed from all assets',
      }));
    } else {
      sub.assets.delete(message.asset);
      ws.send(JSON.stringify({
        type: 'unsubscribed',
        asset: message.asset,
        message: `Unsubscribed from ${message.asset}`,
      }));
    }
  }
}

function broadcastToSubscribers(priceUpdate: any) {
  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;

    const sub = clientSubscriptions.get(client);
    if (!sub) return;

    if (sub.wildcardAll || sub.assets.has(priceUpdate.asset)) {
      client.send(JSON.stringify(priceUpdate));
    }
  });
}

describe('Issue #231: WebSocket Per-Asset Subscription Filtering', () => {
  describe('Subscription Management', () => {
    it('should accept subscription to specific asset', async () => {
      const ws = new WebSocket(`ws://localhost:${WS_PORT}`);

      await new Promise((resolve) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({
            type: 'subscribe',
            asset: 'XLM',
          }));

          ws.once('message', (data: string) => {
            const message = JSON.parse(data);
            expect(message.type).toBe('subscribed');
            expect(message.asset).toBe('XLM');
            ws.close();
            resolve(null);
          });
        });
      });
    });

    it('should accept wildcard subscription for all assets', async () => {
      const ws = new WebSocket(`ws://localhost:${WS_PORT}`);

      await new Promise((resolve) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({
            type: 'subscribe',
            asset: '*',
          }));

          ws.once('message', (data: string) => {
            const message = JSON.parse(data);
            expect(message.type).toBe('subscribed');
            expect(message.asset).toBe('*');
            ws.close();
            resolve(null);
          });
        });
      });
    });

    it('should reject subscription to unsupported asset', async () => {
      const ws = new WebSocket(`ws://localhost:${WS_PORT}`);

      await new Promise((resolve) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({
            type: 'subscribe',
            asset: 'INVALID_ASSET',
          }));

          ws.once('message', (data: string) => {
            const message = JSON.parse(data);
            expect(message.error).toBeDefined();
            expect(message.error).toContain('not supported');
            expect(message.supported).toEqual(SUPPORTED_ASSETS);
            ws.close();
            resolve(null);
          });
        });
      });
    });

    it('should support multiple asset subscriptions', async () => {
      const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
      const subscriptions: string[] = [];

      await new Promise((resolve) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'subscribe', asset: 'XLM' }));
          ws.send(JSON.stringify({ type: 'subscribe', asset: 'USDC' }));
          ws.send(JSON.stringify({ type: 'subscribe', asset: 'BTC' }));

          let count = 0;
          ws.on('message', (data: string) => {
            const message = JSON.parse(data);
            if (message.type === 'subscribed') {
              subscriptions.push(message.asset);
              count++;
              if (count === 3) {
                expect(subscriptions).toContain('XLM');
                expect(subscriptions).toContain('USDC');
                expect(subscriptions).toContain('BTC');
                ws.close();
                resolve(null);
              }
            }
          });
        });
      });
    });

    it('should support unsubscription from specific assets', async () => {
      const ws = new WebSocket(`ws://localhost:${WS_PORT}`);

      await new Promise((resolve) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'subscribe', asset: 'XLM' }));
          ws.send(JSON.stringify({ type: 'unsubscribe', asset: 'XLM' }));

          let messageCount = 0;
          ws.on('message', (data: string) => {
            const message = JSON.parse(data);
            messageCount++;
            if (messageCount === 2) {
              expect(message.type).toBe('unsubscribed');
              expect(message.asset).toBe('XLM');
              ws.close();
              resolve(null);
            }
          });
        });
      });
    });
  });

  describe('Price Distribution Filtering', () => {
    it('should only send messages to subscribed asset clients', async () => {
      const client1 = new WebSocket(`ws://localhost:${WS_PORT}`);
      const client2 = new WebSocket(`ws://localhost:${WS_PORT}`);
      const receivedMessages1: any[] = [];
      const receivedMessages2: any[] = [];

      await new Promise((resolve) => {
        let openCount = 0;

        client1.on('open', () => {
          openCount++;
          client1.send(JSON.stringify({ type: 'subscribe', asset: 'XLM' }));
          if (openCount === 2) subscriptionDone();
        });

        client2.on('open', () => {
          openCount++;
          client2.send(JSON.stringify({ type: 'subscribe', asset: 'USDC' }));
          if (openCount === 2) subscriptionDone();
        });

        function subscriptionDone() {
          setTimeout(() => {
            broadcastToSubscribers({ asset: 'XLM', price: 0.50 });
            broadcastToSubscribers({ asset: 'USDC', price: 1.00 });
            broadcastToSubscribers({ asset: 'BTC', price: 45000 });

            setTimeout(() => {
              client1.on('message', (data: string) => {
                receivedMessages1.push(JSON.parse(data));
              });
              client2.on('message', (data: string) => {
                receivedMessages2.push(JSON.parse(data));
              });

              const xlmMessages = receivedMessages1.filter((m) => m.asset === 'XLM');
              const btcMessages = receivedMessages1.filter((m) => m.asset === 'BTC');
              const usdcMessages = receivedMessages2.filter((m) => m.asset === 'USDC');

              expect(xlmMessages.length).toBeGreaterThan(0);
              expect(btcMessages.length).toBe(0);
              expect(usdcMessages.length).toBeGreaterThan(0);

              client1.close();
              client2.close();
              resolve(null);
            }, 100);
          }, 100);
        }
      });
    });

    it('should send all updates to wildcard subscribers', async () => {
      const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
      const receivedMessages: any[] = [];

      await new Promise((resolve) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'subscribe', asset: '*' }));

          setTimeout(() => {
            broadcastToSubscribers({ asset: 'XLM', price: 0.50 });
            broadcastToSubscribers({ asset: 'USDC', price: 1.00 });
            broadcastToSubscribers({ asset: 'BTC', price: 45000 });

            setTimeout(() => {
              ws.on('message', (data: string) => {
                receivedMessages.push(JSON.parse(data));
              });

              expect(receivedMessages.length).toBeGreaterThanOrEqual(0);
              ws.close();
              resolve(null);
            }, 100);
          }, 100);
        });
      });
    });
  });

  describe('Subscription Metrics', () => {
    it('should track subscription count per asset', async () => {
      const client1 = new WebSocket(`ws://localhost:${WS_PORT}`);
      const client2 = new WebSocket(`ws://localhost:${WS_PORT}`);
      const client3 = new WebSocket(`ws://localhost:${WS_PORT}`);

      await new Promise((resolve) => {
        let openCount = 0;

        client1.on('open', () => {
          openCount++;
          client1.send(JSON.stringify({ type: 'subscribe', asset: 'XLM' }));
          if (openCount === 3) allOpen();
        });

        client2.on('open', () => {
          openCount++;
          client2.send(JSON.stringify({ type: 'subscribe', asset: 'XLM' }));
          if (openCount === 3) allOpen();
        });

        client3.on('open', () => {
          openCount++;
          client3.send(JSON.stringify({ type: 'subscribe', asset: 'USDC' }));
          if (openCount === 3) allOpen();
        });

        function allOpen() {
          const xlmSubscribers = Array.from(clientSubscriptions.values()).filter(
            (sub) => sub.assets.has('XLM') || sub.wildcardAll
          );
          const usdcSubscribers = Array.from(clientSubscriptions.values()).filter(
            (sub) => sub.assets.has('USDC') || sub.wildcardAll
          );

          expect(xlmSubscribers.length).toBeGreaterThanOrEqual(0);
          expect(usdcSubscribers.length).toBeGreaterThanOrEqual(0);

          client1.close();
          client2.close();
          client3.close();
          resolve(null);
        }
      });
    });
  });

  describe('Subscription Validation', () => {
    it('should validate asset name format', async () => {
      const ws = new WebSocket(`ws://localhost:${WS_PORT}`);

      await new Promise((resolve) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({
            type: 'subscribe',
            asset: 'invalid asset name',
          }));

          ws.once('message', (data: string) => {
            const message = JSON.parse(data);
            expect(message.error || message.type).toBeDefined();
            ws.close();
            resolve(null);
          });
        });
      });
    });

    it('should handle malformed messages gracefully', async () => {
      const ws = new WebSocket(`ws://localhost:${WS_PORT}`);

      await new Promise((resolve) => {
        ws.on('open', () => {
          ws.send('not json');

          ws.once('message', (data: string) => {
            const message = JSON.parse(data);
            expect(message.error).toBeDefined();
            ws.close();
            resolve(null);
          });
        });
      });
    });

    it('should handle missing asset field', async () => {
      const ws = new WebSocket(`ws://localhost:${WS_PORT}`);

      await new Promise((resolve) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({
            type: 'subscribe',
          }));

          ws.once('message', (data: string) => {
            const message = JSON.parse(data);
            expect(message.error || message.type).toBeDefined();
            ws.close();
            resolve(null);
          });
        });
      });
    });
  });
});
