#!/usr/bin/env node
/**
 * Serves build/ locally with the headers production sends, so the page runs
 * under the same Content-Security-Policy.
 *
 *   npm run dev              # http://localhost:8789
 *   PORT=9000 npm run dev
 *
 * With DEMO=1 it also serves a demo terminal stream at /demo, as a chat
 * server serves live text (PROTOCOL.md §4.8.5), and prints a link to view it.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { build, HEADERS } from './build.mjs';

const out = build();
const port = Number(process.env.PORT ?? 8789);

/** @type {Record<string, string>} */
const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.txt': 'text/plain; charset=utf-8'
};

/** Lines of a pretend test run, with colors, a progress bar redrawn with carriage returns, and a summary. */
async function demo(/** @type {import('node:http').ServerResponse} */ response) {
	response.writeHead(200, {
		'Content-Type': 'text/plain; charset=utf-8',
		'X-Content-Type-Options': 'nosniff',
		'Cache-Control': 'no-transform',
		'Access-Control-Allow-Origin': '*'
	});
	const wait = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
	response.write('\x1b[1m$ make test\x1b[0m\r\n');
	for (let i = 1; i <= 30; i++) {
		await wait(80);
		response.write(`\x1b[32mok\x1b[0m   pkg/module${String(i).padStart(2, '0')}  ${(i * 0.013).toFixed(3)}s\r\n`);
	}
	for (let done = 0; done <= 40; done++) {
		await wait(40);
		response.write(`\rbuilding [${'#'.repeat(done)}${' '.repeat(40 - done)}] ${String(Math.round((done / 40) * 100)).padStart(3)}%`);
	}
	response.end('\r\n\x1b[1;32mPASS\x1b[0m  30 packages  \x1b[2m(0.41s)\x1b[0m\r\n');
}

createServer(async (request, response) => {
	const path = new URL(request.url ?? '/', 'http://localhost').pathname;
	if (process.env.DEMO && path === '/demo') return demo(response);
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
}).listen(port, () => {
	console.log(`Serving ${out} at http://localhost:${port}/`);
	if (process.env.DEMO) console.log(`Demo: http://localhost:${port}/#stream=${encodeURIComponent(`http://localhost:${port}/demo`)}&title=make%20test`);
});
