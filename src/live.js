// @ts-check
/**
 * Reading live text (PROTOCOL.md §4.8.5), as apron-web reads it
 * (src/lib/protocol/live-text.ts): `GET url` returns the text the server
 * kept, from its start, then more as it arrives, and ends when the text ends.
 * A reader that reconnects replaces what it showed with the new response.
 */

/**
 * What a reader of live text is told, in order: `start`, then `chunk`s; after
 * a drop, `retrying`, then `start` again.
 * @typedef {object} LiveTextSink
 * @property {() => void} start a response began: it replaces whatever was shown, from the start of the text
 * @property {(bytes: Uint8Array) => void} chunk the next bytes, as they arrived: UTF-8, not cut at a character
 * @property {(retry: Retry) => void} [retrying] a read failed or dropped, and another starts after `delay` ms
 */

/**
 * @typedef {object} Retry
 * @property {number} failures the reads that failed in a row, this one included
 * @property {number} delay how long until the next, in ms
 * @property {number} [status] the server's status, when it answered with one other than OK
 */

/** The longest a server's `Retry-After` makes a reader wait, in ms. */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * How following live text stopped: it `ended` (the response ended, so the
 * text did), the server `refused` it with a status that trying again would not
 * change, or it was `aborted`.
 * @typedef {{ how: 'ended' } | { how: 'refused', status: number } | { how: 'aborted' }} Outcome
 */

/** @typedef {(url: string, init: RequestInit) => Promise<Response>} LiveFetch */

/** The pauses before trying again after a failure or a drop, the last repeated: a stream may not serve yet, or its connection may drop. */
export const LIVE_RETRY_MS = /** @type {const} */ ([1000, 2000, 4000, 8000, 15000]);

/**
 * A decoder for live text's bytes, as the server converts the text it keeps
 * (§4.8.5): WHATWG's UTF-8 decode without BOM, so each invalid sequence reads
 * as one U+FFFD and a leading BOM stays. Decode each response with
 * `{stream: true}`, which carries a character cut between chunks, and call
 * `decode()` at its end.
 */
export function liveTextDecoder() {
	return new TextDecoder('utf-8', { ignoreBOM: true });
}

/** A `GET url` the server answered with a status other than OK. */
export class LiveTextStatusError extends Error {
	/**
	 * @param {number} status
	 * @param {number} [retryAfterMs] how long the server asked readers to wait (`Retry-After`), such as a reader cap's 429
	 */
	constructor(status, retryAfterMs) {
		super(`The stream is not available (${status})`);
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

/**
 * A `Retry-After` header's wait, in ms: seconds, or an HTTP date. Undefined
 * without one, or for one that can't be read. apron-server-cloudflare sends
 * it with a 429 when a text has as many readers as it may have, and exposes
 * it to other origins.
 * @param {string | null} value
 * @param {number} [now]
 */
export function retryAfterMs(value, now = Date.now()) {
	if (!value) return undefined;
	const text = value.trim();
	if (/^\d+$/.test(text)) return Number(text) * 1000;
	const date = Date.parse(text);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * A server's answer that trying again would not change: a 4xx other than 408
 * (Request Timeout) and 429 (Too Many Requests), such as a reader cap's 403 or
 * an ended text's 404 or 410. Each try may count against the server's limits
 * on reading, so a reader that kept trying could use them up.
 * @param {number} status
 */
export function definitive(status) {
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * One `GET url`: resolves when the text ends, rejects when it fails or drops
 * (with `LiveTextStatusError` for a status other than OK). It sends no
 * cookies and no referrer: the address is all a reader needs.
 * @param {string} url
 * @param {LiveTextSink} sink
 * @param {AbortSignal} signal
 * @param {LiveFetch} fetcher
 */
export async function readLiveText(url, sink, signal, fetcher) {
	const response = await fetcher(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
	if (!response.ok || !response.body) throw new LiveTextStatusError(response.status, retryAfterMs(response.headers.get('Retry-After')));
	const reader = response.body.getReader();
	sink.start();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value?.byteLength) sink.chunk(value);
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Follows live text until it ends, the server refuses it for good, or
 * `signal` aborts. After a failure or a drop it tries again, waiting longer
 * each time it fails before a response starts (`retryMs`); a response that
 * started and then dropped starts the waits over. It waits at least as long
 * as the server's `Retry-After` asks, up to `MAX_RETRY_AFTER_MS`: each try
 * may count against the server's limits on connecting.
 * @param {string} url
 * @param {LiveTextSink} sink
 * @param {AbortSignal} signal
 * @param {{ retryMs?: readonly number[], fetch?: LiveFetch }} [options]
 * @returns {Promise<Outcome>}
 */
export async function followLiveText(url, sink, signal, { retryMs = LIVE_RETRY_MS, fetch: fetcher = (u, init) => fetch(u, init) } = {}) {
	let failures = 0;
	while (!signal.aborted) {
		let started = false;
		/** @type {LiveTextSink} */
		const counted = {
			start: () => {
				started = true;
				sink.start();
			},
			chunk: (bytes) => sink.chunk(bytes)
		};
		try {
			await readLiveText(url, counted, signal, fetcher);
			return { how: 'ended' };
		} catch (cause) {
			if (signal.aborted) break;
			const status = cause instanceof LiveTextStatusError ? cause.status : undefined;
			if (status !== undefined && definitive(status)) return { how: 'refused', status };
			failures = started ? 1 : failures + 1;
			const asked = cause instanceof LiveTextStatusError ? cause.retryAfterMs : undefined;
			const delay = Math.max(retryMs[Math.min(failures, retryMs.length) - 1] ?? 0, Math.min(asked ?? 0, MAX_RETRY_AFTER_MS));
			sink.retrying?.({ failures, delay, ...(status !== undefined ? { status } : {}) });
			await pause(delay, signal);
		}
	}
	return { how: 'aborted' };
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function pause(ms, signal) {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
		function done() {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		}
	});
}
