import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStreamUrl, cleanTitle, isLoopback, MAX_TITLE, parseLocation, viewerUrl } from '../src/stream.js';

const at = (/** @type {string} */ hash, search = '') => parseLocation({ hash, search });

test('no keys: the page says what it is', () => {
	assert.deepEqual(at(''), { kind: 'empty' });
	assert.deepEqual(at('#'), { kind: 'empty' });
});

test('a stream, encoded or not', () => {
	const expected = { kind: 'stream', stream: { url: 'https://server.apron.chat/t/p3Wn9d', host: 'server.apron.chat' } };
	assert.deepEqual(at('#stream=https://server.apron.chat/t/p3Wn9d'), expected);
	assert.deepEqual(at('#stream=https%3A%2F%2Fserver.apron.chat%2Ft%2Fp3Wn9d'), expected);
});

test('a stream with a query of its own, encoded', () => {
	const url = 'https://chat.example:8443/live/abc?token=x&y=1';
	const parsed = at(`#stream=${encodeURIComponent(url)}&title=make%20test`);
	assert.deepEqual(parsed, { kind: 'stream', stream: { url, host: 'chat.example:8443', title: 'make test' } });
});

test('a repeated key counts with its first value', () => {
	const parsed = at('#stream=https://a.example/t/1&stream=https://b.example/t/2&title=one&title=two');
	assert.equal(parsed.kind, 'stream');
	assert.equal(parsed.kind === 'stream' && parsed.stream.url, 'https://a.example/t/1');
	assert.equal(parsed.kind === 'stream' && parsed.stream.title, 'one');
});

test('keys without a stream', () => {
	assert.deepEqual(at('#title=make'), { kind: 'invalid', reason: 'no-stream' });
	assert.deepEqual(at('#stream='), { kind: 'invalid', reason: 'no-stream' });
});

test('a stream in the query has reached the host', () => {
	assert.deepEqual(at('', '?stream=https://a.example/t/1'), { kind: 'invalid', reason: 'exposed-stream' });
	assert.deepEqual(at('#stream=https://a.example/t/1', '?stream=https://a.example/t/1'), { kind: 'invalid', reason: 'exposed-stream' });
});

test('only https, or http to this device', () => {
	assert.equal(checkStreamUrl('http://chat.example/t/1'), 'insecure-stream');
	assert.equal(checkStreamUrl('http://192.168.1.2/t/1'), 'insecure-stream');
	assert.equal(checkStreamUrl('javascript:alert(1)'), 'bad-stream');
	assert.equal(checkStreamUrl('data:text/plain,hi'), 'bad-stream');
	assert.equal(checkStreamUrl('ftp://chat.example/t/1'), 'bad-stream');
	assert.equal(checkStreamUrl('/t/1'), 'bad-stream');
	assert.equal(checkStreamUrl('not a url'), 'bad-stream');
	assert.equal(checkStreamUrl('http://[::1]:3000/t/1'), 'insecure-stream', 'a CSP source cannot name an IPv6 address');
	for (const url of ['http://localhost:8080/t/1', 'http://127.0.0.1/t/1', 'http://apron.localhost/t/1']) {
		assert.ok(checkStreamUrl(url) instanceof URL, url);
	}
});

test('no credentials, and no fragment', () => {
	assert.equal(checkStreamUrl('https://user:pass@chat.example/t/1'), 'credentials-in-stream');
	assert.equal(checkStreamUrl('https://user@chat.example/t/1'), 'credentials-in-stream');
	assert.equal(String(checkStreamUrl('https://chat.example/t/1#x')), 'https://chat.example/t/1');
});

test('loopback hosts', () => {
	assert.ok(isLoopback('localhost'));
	assert.ok(isLoopback('127.0.0.1'));
	assert.ok(isLoopback('apron.localhost'));
	assert.ok(!isLoopback('localhost.example'));
	assert.ok(!isLoopback('10.0.0.1'));
});

test('titles: one line, no reordering controls, bounded', () => {
	assert.equal(cleanTitle('  make\ttest\r\n'), 'make test');
	assert.equal(cleanTitle('a‮b⁦c'), 'a b c');
	assert.equal(cleanTitle('\u001b[31mred'), '[31mred');
	const long = cleanTitle('x'.repeat(500));
	assert.equal([...long].length, MAX_TITLE);
	assert.ok(long.endsWith('…'));
	assert.equal(cleanTitle('😀'.repeat(MAX_TITLE)), '😀'.repeat(MAX_TITLE));
});

test('viewerUrl is what parseLocation reads', () => {
	for (const stream of [
		{ url: 'https://server.apron.chat/t/p3Wn9d' },
		{ url: 'https://chat.example/live/a?b=1&c=2+3%20', title: 'npm run build && npm test' },
		{ url: 'http://localhost:8080/t/x', title: 'tést #1 100%' }
	]) {
		const link = new URL(viewerUrl('https://terminal.apron.chat', stream));
		assert.equal(link.origin, 'https://terminal.apron.chat');
		const parsed = parseLocation(link);
		assert.equal(parsed.kind, 'stream');
		assert.equal(parsed.kind === 'stream' && parsed.stream.url, new URL(stream.url).toString());
		assert.equal(parsed.kind === 'stream' ? parsed.stream.title : undefined, stream.title);
	}
	assert.equal(viewerUrl('https://terminal.apron.chat', { url: 'https://server.apron.chat/t/p3Wn9d' }), 'https://terminal.apron.chat/#stream=https://server.apron.chat/t/p3Wn9d');
});
