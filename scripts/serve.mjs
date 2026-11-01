#!/usr/bin/env node
/**
 * Serves build/ locally with the headers production sends, so the page runs
 * under the same Content-Security-Policy, except that it may also read
 * streams over http from this device (LOCAL_CONNECT_SOURCES).
 *
 *   npm run dev              # http://localhost:8789
 *   PORT=9000 npm run dev
 *
 * With DEMO=1 it also serves a demo terminal stream (scripts/demo.mjs) at
 * /demo, as a chat server serves live text (PROTOCOL.md §4.8.5), and prints a
 * link to view it.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, DEV_HEADERS as HEADERS } from './build.mjs';
import { demo } from './demo.mjs';

/** @type {Record<string, string>} */
const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.txt': 'text/plain; charset=utf-8'
};

/**
 * Streams the demo run as live text. With `hold`, the response stays open
 * once the run is written, as a program still running would leave it.
 * @param {import('node:http').ServerResponse} response
 * @param {{ hold?: boolean }} [options]
 */
async function streamDemo(response, { hold = false } = {}) {
	response.writeHead(200, {
		'Content-Type': 'text/plain; charset=utf-8',
		'X-Content-Type-Options': 'nosniff',
		'Cache-Control': 'no-transform',
		'Access-Control-Allow-Origin': '*'
	});
	for (const [pause, text] of demo()) {
		if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
		if (response.destroyed) return;
		response.write(text);
	}
	if (!hold) response.end();
}

/**
 * Builds the site and serves it on `port` (0 for any free one).
 * @param {{ port?: number, demo?: boolean }} [options]
 * @returns {Promise<{ url: string, close: () => void }>}
 */
export async function serve({ port = 8789, demo: withDemo = false } = {}) {
	const out = build();
	const server = createServer(async (request, response) => {
		const { pathname: path, searchParams } = new URL(request.url ?? '/', 'http://localhost');
		if (withDemo && path === '/demo') return streamDemo(response, { hold: searchParams.has('hold') });
		const file = normalize(join(out, path.endsWith('/') ? `${path}index.html` : path));
		try {
			if (!file.startsWith(out) || path === '/_headers') throw new Error('not served');
			const body = await readFile(file);
			response.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
			response.end(body);
		} catch {
			response.writeHead(404, { ...HEADERS, 'Content-Type': TYPES['.html'] });
			response.end(await readFile(join(out, '404.html')));
		}
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, () => resolve(undefined));
	});
	const address = server.address();
	const url = `http://localhost:${typeof address === 'object' && address ? address.port : port}`;
	return { url, close: () => server.closeAllConnections() || server.close() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const withDemo = Boolean(process.env.DEMO);
	const { url } = await serve({ port: Number(process.env.PORT ?? 8789), demo: withDemo });
	console.log(`Serving build/ at ${url}/`);
	if (withDemo) console.log(`Demo: ${url}/#stream=${encodeURIComponent(`${url}/demo`)}&title=make%20release`);
}
