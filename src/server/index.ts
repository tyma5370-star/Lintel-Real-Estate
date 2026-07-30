import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { NETWORK_URL } from '../config';
import { HttpError } from './http-error';
import { routes, type Route } from './routes';

export { HttpError };

/**
 * A thin HTTP layer over `src/ledger` and `src/underwriting`.
 *
 * Deliberately dependency-free — Node's own http module, hand-rolled routing.
 * Adding Express to expose eight read endpoints and two commands would be more
 * code, not less, and this boundary exists so a UI can be built against it
 * without importing `xrpl` anywhere near the front end.
 *
 * Every read endpoint hits the ledger. Nothing is cached.
 */

const PORT = Number(process.env.PORT ?? 8787);

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

function match(route: Route, method: string, pathname: string): Record<string, string> | null {
  if (route.method !== method) return null;
  const routeParts = route.path.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (routeParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < routeParts.length; i++) {
    const routePart = routeParts[i]!;
    const pathPart = pathParts[i]!;
    if (routePart.startsWith(':')) params[routePart.slice(1)] = decodeURIComponent(pathPart);
    else if (routePart !== pathPart) return null;
  }
  return params;
}

const server = createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (method === 'OPTIONS') {
    send(res, 204, null);
    return;
  }

  for (const route of routes) {
    const params = match(route, method, url.pathname);
    if (!params) continue;

    try {
      const body = method === 'POST' ? await readBody(req) : {};
      const result = await route.handle({ params, query: url.searchParams, body });
      send(res, 200, result);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      // Surface the real reason. A generic 500 on a tec code wastes the one piece
      // of information that would explain the failure.
      send(res, status, { error: message });
    }
    return;
  }

  send(res, 404, {
    error: `No route for ${method} ${url.pathname}`,
    routes: routes.map((r) => `${r.method} ${r.path}`),
  });
});

server.listen(PORT, () => {
  console.log(`Bridge API listening on http://localhost:${PORT}`);
  console.log(`Network: ${NETWORK_URL}`);
  console.log('');
  for (const route of routes) console.log(`  ${route.method.padEnd(4)} ${route.path.padEnd(28)} ${route.summary}`);
});
