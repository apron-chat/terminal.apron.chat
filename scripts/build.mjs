#!/usr/bin/env node
/**
 * Builds the site into build/: the page, xterm.js and its stylesheet from
 * node_modules, and `_headers`.
 *
 *   npm run build
 *
 * The output is files only. Nothing in it runs on the server.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');

/** Files copied from src/ as they are. */
export const PAGE_FILES = ['index.html', '404.html', 'style.css', 'app.js', 'stream.js', 'live.js', 'screen.js', 'embed.js', 'formats.js', 'logo.svg', 'robots.txt'];

/**
 * Where the page may read a stream from: any https origin. Live text is
 * served with `Access-Control-Allow-Origin: *` (PROTOCOL.md §4.8.5), so the
 * page reads it without credentials.
 */
export const CONNECT_SOURCES = ['https:'];

/**
 * And, served by `npm run dev` only, http on this device, as `checkStreamUrl`
 * in src/stream.js allows on a page that is on this device too. (A CSP source
 * can't name an IPv6 address, so http://[::1] isn't one.) Never in
 * production: a link could make every viewer's browser read their own
 * machine's local services.
 */
export const LOCAL_CONNECT_SOURCES = ['http://localhost:*', 'http://*.localhost:*', 'http://127.0.0.1:*'];

/**
 * Headers for every response. The page builds all of its markup with DOM
 * calls, so it can forbid inline scripts, other origins, and the DOM's HTML
 * sinks (Trusted Types): a stream's bytes only ever reach the page as
 * terminal cells. Inline styles are allowed because xterm.js sizes and colors
 * its screen with `<style>` elements and `style` attributes it writes itself.
 *
 * Any page may show it in a frame (README.md, Embedding): it has nothing to
 * click that acts for its viewer. Its files may be read from any origin,
 * because in a sandboxed iframe without `allow-same-origin` the page's origin
 * is opaque, and a module script, and each module it imports, loads with CORS.
 */
export const HEADERS = headers(CONNECT_SOURCES);

/** The headers for the development server: production's, and streams from this device. */
export const DEV_HEADERS = headers([...CONNECT_SOURCES, ...LOCAL_CONNECT_SOURCES]);

/**
 * @param {string[]} connect where the page may read streams from
 * @returns {Record<string, string>}
 */
function headers(connect) {
	return {
		'Content-Security-Policy': [
			"default-src 'none'",
			"script-src 'self'",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self'",
			`connect-src ${connect.join(' ')}`,
			"base-uri 'none'",
			"form-action 'none'",
			'frame-ancestors *',
			"require-trusted-types-for 'script'",
			"trusted-types 'none'"
		].join('; '),
		'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Access-Control-Allow-Origin': '*',
		'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()'
	};
}

/** `_headers` for Cloudflare static assets. */
export function headersFile() {
	const lines = Object.entries(HEADERS).map(([name, value]) => `  ${name}: ${value}`);
	return `/*\n${lines.join('\n')}\n`;
}

/** The files of the xterm.js package that the page loads, by what build/ calls them. */
function xtermFiles() {
	const require = createRequire(import.meta.url);
	const pkg = dirname(require.resolve('@xterm/xterm/package.json'));
	return {
		// The module, with its license header, without the source map it points to (not shipped).
		'xterm.mjs': readFileSync(join(pkg, 'lib', 'xterm.mjs'), 'utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n'),
		'xterm.css': readFileSync(join(pkg, 'css', 'xterm.css'), 'utf8')
	};
}

export function build() {
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	for (const file of PAGE_FILES) cpSync(join(root, 'src', file), join(out, file));
	for (const [name, text] of Object.entries(xtermFiles())) writeFileSync(join(out, name), text);
	writeFileSync(join(out, '_headers'), headersFile());
	return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		console.log(`Built ${build()}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
