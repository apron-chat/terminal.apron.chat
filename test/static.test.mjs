import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build, CONNECT_SOURCES, PAGE_FILES } from '../scripts/build.mjs';

const root = new URL('..', import.meta.url).pathname;

test('the site is static: no Worker code is deployed', () => {
	const config = readFileSync(join(root, 'wrangler.toml'), 'utf8');
	assert.doesNotMatch(config, /^\s*main\s*=/m, 'wrangler.toml must not set main');
	assert.doesNotMatch(config, /run_worker_first/, 'wrangler.toml must not run a Worker first');
});

test('the build holds only the expected files', () => {
	const out = build();
	/** @param {string} dir @returns {string[]} */
	const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [relative(out, join(dir, entry.name))]));
	assert.deepEqual(walk(out).sort(), [...PAGE_FILES, '_headers', 'xterm.css', 'xterm.mjs'].sort());
	const headers = readFileSync(join(out, '_headers'), 'utf8');
	assert.match(headers, /^\/\*\n {2}Content-Security-Policy: default-src 'none'; script-src 'self';/);
	assert.match(headers, /connect-src https: http:\/\/localhost:\* http:\/\/\*\.localhost:\* http:\/\/127\.0\.0\.1:\*;/);
	for (const source of CONNECT_SOURCES) assert.doesNotMatch(source, /\[/, 'CSP sources cannot name an IPv6 address');
	assert.match(headers, /trusted-types 'none'/);
	// Any page may frame it, sandboxed too: its modules then load with CORS from an opaque origin.
	assert.match(headers, /frame-ancestors \*;/);
	assert.match(headers, /^ {2}Access-Control-Allow-Origin: \*$/m);
	assert.doesNotMatch(headers, /X-Frame-Options/i);
	assert.match(headers, /Referrer-Policy: no-referrer/);
	const xterm = readFileSync(join(out, 'xterm.mjs'), 'utf8');
	assert.match(xterm, /^\/\*\*\n \* Copyright \(c\) 2014-2024 The xterm\.js authors\. All rights reserved\.\n \* @license MIT/, 'xterm.mjs keeps its license');
	assert.doesNotMatch(xterm, /sourceMappingURL/, 'no source map is shipped');
	assert.match(xterm, /export\s*\{[^}]*\bas Terminal\b/);
});

test('the page never uses an HTML sink or runs strings', () => {
	for (const file of PAGE_FILES.filter((name) => name.endsWith('.js'))) {
		const source = readFileSync(join(root, 'src', file), 'utf8');
		assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, file);
	}
});

test('the page loads nothing from another origin', () => {
	for (const file of PAGE_FILES.filter((name) => name.endsWith('.html'))) {
		const source = readFileSync(join(root, 'src', file), 'utf8');
		for (const [, url] of source.matchAll(/(?:src|href)="([^"]+)"/g)) {
			assert.ok(url.startsWith('/') || url.startsWith('https://github.com/'), `${file}: ${url}`);
			if (url.startsWith('https://')) assert.doesNotMatch(source, new RegExp(`(?:src|rel="stylesheet" href)="${url}`), `${file} loads ${url}`);
		}
	}
});
