import { Client } from 'xrpl';
import { NETWORK_URL } from '../config';

let client: Client | null = null;

/** Connection singleton. Every script shares one websocket. */
export async function getClient(): Promise<Client> {
  if (client?.isConnected()) return client;
  if (!client) client = new Client(NETWORK_URL, { timeout: 30_000 });
  if (!client.isConnected()) await client.connect();
  return client;
}

export async function disconnect(): Promise<void> {
  if (client?.isConnected()) await client.disconnect();
  client = null;
}

/**
 * Run `fn` with a connected client and always disconnect, so a script never
 * hangs the process on an open socket after an error.
 */
export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  try {
    return await fn(await getClient());
  } finally {
    await disconnect();
  }
}
