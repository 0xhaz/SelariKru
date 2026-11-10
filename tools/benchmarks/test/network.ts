import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { vi, type MockInstance } from 'vitest';

/** Spies on every way this process could reach the network. Each spy throws, so a call fails loudly as well as being recorded. */
export function watchNetwork(): { calls: () => string[]; restore: () => void } {
  const seen: string[] = [];
  const refuse = (name: string) => (): never => {
    seen.push(name);
    throw new Error(`network call refused in a test: ${name}`);
  };
  const spies: MockInstance[] = [
    vi.spyOn(globalThis, 'fetch').mockImplementation(refuse('fetch')),
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(refuse('net.Socket.connect')),
    vi.spyOn(net, 'connect').mockImplementation(refuse('net.connect')),
    vi.spyOn(net, 'createConnection').mockImplementation(refuse('net.createConnection')),
    vi.spyOn(tls, 'connect').mockImplementation(refuse('tls.connect')),
    vi.spyOn(http, 'request').mockImplementation(refuse('http.request')),
    vi.spyOn(http, 'get').mockImplementation(refuse('http.get')),
    vi.spyOn(https, 'request').mockImplementation(refuse('https.request')),
    vi.spyOn(https, 'get').mockImplementation(refuse('https.get')),
    vi.spyOn(dns, 'lookup').mockImplementation(refuse('dns.lookup')),
  ];
  return { calls: () => [...seen], restore: () => { for (const s of spies) s.mockRestore(); } };
}
