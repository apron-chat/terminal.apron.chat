import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definitive, followLiveText, liveTextDecoder } from '../src/live.js';

const NO_WAIT = [0, 0, 0];

/** A response whose body is `chunks`, then ends, or fails after them with `fail`. */
function response(/** @type {string[]} */ chunks, { status = 200, fail = false } = {}) {
	const encoder = new TextEncoder();
	const queue = [...chunks];
	// One chunk a read, so a failure comes after the chunks before it are read, as a dropped connection's does.
	const body = new ReadableStream({
		pull(controller) {
			const chunk = queue.shift();
			if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
			else if (fail) controller.error(new TypeError('network error'));
			else controller.close();
		}
	});
	return new Response(status === 200 ? body : 'refused', { status });
}

/** A sink that records what it is told, as text. */
function recorder() {
	/** @type {string[]} */
	const events = [];
	const decoder = new TextDecoder();
	return {
		events,
		sink: {
			start: () => events.push('start'),
			chunk: (/** @type {Uint8Array} */ bytes) => events.push(decoder.decode(bytes)),
			retrying: (/** @type {import('../src/live.js').Retry} */ retry) => events.push(`retry ${retry.failures}${retry.status ? ` ${retry.status}` : ''}`)
		}
	};
}

test('reads a stream to its end', async () => {
	const { events, sink } = recorder();
	/** @type {RequestInit[]} */
	const inits = [];
	const outcome = await followLiveText('https://chat.example/t/1', sink, new AbortController().signal, {
		fetch: async (_url, init) => {
			inits.push(init);
			return response(['$ make\r\n', 'ok\r\n']);
		}
	});
	assert.deepEqual(outcome, { how: 'ended' });
	assert.deepEqual(events, ['start', '$ make\r\n', 'ok\r\n']);
	assert.equal(inits[0].credentials, 'omit');
	assert.equal(inits[0].referrerPolicy, 'no-referrer');
	assert.equal(inits[0].cache, 'no-store');
});

test('a drop reconnects, and the new response starts afresh', async () => {
	const { events, sink } = recorder();
	const responses = [response(['one '], { fail: true }), response(['one two'])];
	const outcome = await followLiveText('https://chat.example/t/1', sink, new AbortController().signal, { retryMs: NO_WAIT, fetch: async () => /** @type {Response} */ (responses.shift()) });
	assert.deepEqual(outcome, { how: 'ended' });
	assert.deepEqual(events, ['start', 'one ', 'retry 1', 'start', 'one two']);
});

test('failures before a response count up; 5xx, 408 and 429 are tried again', async () => {
	const { events, sink } = recorder();
	const responses = [response([], { status: 503 }), response([], { status: 429 }), response([], { status: 408 })];
	const outcome = await followLiveText('https://chat.example/t/1', sink, new AbortController().signal, {
		retryMs: NO_WAIT,
		fetch: async () => {
			const next = responses.shift();
			if (next) return next;
			if (events.length < 4) throw new TypeError('offline');
			return response(['back']);
		}
	});
	assert.deepEqual(outcome, { how: 'ended' });
	assert.deepEqual(events, ['retry 1 503', 'retry 2 429', 'retry 3 408', 'retry 4', 'start', 'back']);
});

test('a definitive 4xx stops it, without trying again', async () => {
	for (const status of [400, 401, 403, 404, 410]) {
		const { events, sink } = recorder();
		let calls = 0;
		const outcome = await followLiveText('https://chat.example/t/1', sink, new AbortController().signal, {
			retryMs: NO_WAIT,
			fetch: async () => {
				calls++;
				return response([], { status });
			}
		});
		assert.deepEqual(outcome, { how: 'refused', status });
		assert.equal(calls, 1);
		assert.deepEqual(events, []);
	}
	assert.ok(!definitive(408) && !definitive(429) && !definitive(500) && definitive(404));
});

test('an abort stops it, during a pause too', async () => {
	const controller = new AbortController();
	const { sink } = recorder();
	const following = followLiveText('https://chat.example/t/1', sink, controller.signal, {
		retryMs: [60_000],
		fetch: async () => {
			throw new TypeError('offline');
		}
	});
	setTimeout(() => controller.abort(), 10);
	assert.deepEqual(await following, { how: 'aborted' });
});

test('decoding keeps a character cut between chunks, and keeps a BOM', () => {
	const decoder = liveTextDecoder();
	const bytes = new TextEncoder().encode('﻿é✓');
	let text = '';
	for (const byte of bytes) text += decoder.decode(new Uint8Array([byte]), { stream: true });
	text += decoder.decode();
	assert.equal(text, '﻿é✓');
	assert.equal(liveTextDecoder().decode(new Uint8Array([0x61, 0xff, 0x62])), 'a�b');
});
