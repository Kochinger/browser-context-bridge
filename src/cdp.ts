import * as vscode from 'vscode';

type CdpMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  sessionId?: string;
};

const REQUEST_TIMEOUT_MS = 15000;

/**
 * Request/response correlation over `BrowserTabCDPSession`, which is a raw message
 * channel: `sendMessage` is fire-and-forget and every reply arrives on one event.
 */
class CdpConnection implements vscode.Disposable {
  private nextId = 1;
  private disposed = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly session: vscode.BrowserTabCDPSession) {
    this.subscriptions.push(
      session.onDidReceiveMessage((message) => this.accept(message)),
      session.onDidClose(() => this.failAll(new Error('The browser CDP session closed.'))),
    );
  }

  private accept(message: CdpMessage): void {
    if (typeof message.id === 'number') {
      const request = this.pending.get(message.id);
      if (!request) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        request.reject(new Error(`${message.error.message} (CDP ${message.error.code})`));
      } else {
        request.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === 'string') {
      for (const handler of this.listeners.get(message.method) ?? []) {
        handler(message.params);
      }
    }
  }

  private failAll(error: Error): void {
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  send<T>(method: string, params?: object, sessionId?: string): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('The browser CDP session is closed.'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      void Promise.resolve(this.session.sendMessage({ id, method, params, sessionId })).catch((error: unknown) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  onEvent<T>(method: string, handler: (params: T) => void): vscode.Disposable {
    const handlers = this.listeners.get(method) ?? new Set();
    handlers.add(handler as (params: unknown) => void);
    this.listeners.set(method, handlers);
    return new vscode.Disposable(() => {
      handlers.delete(handler as (params: unknown) => void);
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.failAll(new Error('The browser CDP session was disposed.'));
    this.listeners.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    void Promise.resolve(this.session.close()).catch(() => undefined);
  }
}

/**
 * A CDP session attached to a tab's page target. `startCDPSession` hands out a
 * browser-level session where page domains are not available, so the page target is
 * attached in flattened mode and every later message carries that session ID.
 *
 * The session group is scoped to the tab it was started from — `Target.getTargets`
 * lists only that tab's page — so no URL matching is needed to find the right target.
 */
export class CdpPage implements vscode.Disposable {
  private constructor(
    private readonly connection: CdpConnection,
    private readonly sessionId: string,
  ) {}

  static async attach(tab: vscode.BrowserTab): Promise<CdpPage> {
    const connection = new CdpConnection(await tab.startCDPSession());
    try {
      const { targetInfos } = await connection.send<{ targetInfos: Array<{ targetId: string; type: string }> }>(
        'Target.getTargets',
      );
      const target = targetInfos.find((info) => info.type === 'page') ?? targetInfos[0];
      if (!target) {
        throw new Error('The browser tab exposes no CDP page target.');
      }
      const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      });
      return new CdpPage(connection, sessionId);
    } catch (error) {
      connection.dispose();
      throw error;
    }
  }

  send<T>(method: string, params?: object): Promise<T> {
    return this.connection.send<T>(method, params, this.sessionId);
  }

  onEvent<T>(method: string, handler: (params: T) => void): vscode.Disposable {
    return this.connection.onEvent<T>(method, handler);
  }

  dispose(): void {
    this.connection.dispose();
  }
}
