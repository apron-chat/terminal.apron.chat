// @ts-check
/**
 * Reads the page's own address: which terminal stream to show, and how.
 *
 *   https://terminal.apron.chat/#stream=<url>&title=<title>&embed=1&theme=dark
 *
 * - `stream` is the `url` of a `terminal` embed (PROTOCOL.md §4.8.6), the
 *   live text a chat server serves. Percent-encode it when it has a `&`, `#`,
 *   `+` or `%` of its own. Optional with `embed=1`, for a client that only
 *   sends a finished `output` in (see README.md, Embedding).
 * - `cast` is, in place of `stream`, an asciinema recording to replay (an
 *   asciicast, src/formats.js), such as `https://asciinema.org/a/<id>.cast`.
 *   It is read as `stream` is, and has the same checks.
 * - `title` is optional: the embed's `title`, such as the command.
 * - `embed=1` shows the compact layout for an iframe in a chat message. A
 *   page in a frame shows it anyway.
 * - `theme` is `light` or `dark`, to match the client's; the system's unless
 *   said.
 *
 * A repeated key counts with its first value. The keys belong in the
 * fragment, so the stream's address, which anyone who has it can read, never
 * reaches this site's host.
 */

/** @typedef {'no-stream' | 'bad-stream' | 'insecure-stream' | 'local-stream' | 'credentials-in-stream' | 'exposed-stream'} Reason */

/**
 * How a page reads links: `local`, whether it may read a stream over http
 * from this device. Only a copy of the page that is itself on this device
 * may, such as `npm run dev`'s: on terminal.apron.chat, a link could
 * otherwise make every viewer's browser read whatever their own machine
 * serves on localhost.
 * @typedef {{ local?: boolean }} ReadOptions
 */

/**
 * What the page shows.
 * @typedef {object} View
 * @property {string} [url] the stream's address, or the recording's, as the URL parser writes it; absent only in an embed
 * @property {boolean} [cast] whether `url` is a recording (`cast`) rather than a stream
 * @property {string} [host] where the stream is read from, to show
 * @property {string} [title] what it is, such as the command that writes it
 * @property {boolean} embed the compact layout, for an iframe
 * @property {'light' | 'dark'} [theme] the client's theme
 */

/** @typedef {{ kind: 'empty' } | { kind: 'invalid', reason: Reason, embed: boolean, theme?: 'light' | 'dark' } | { kind: 'view', view: View }} Parsed */

/** The longest title shown, in code points. Longer ones are cut, with an ellipsis. */
export const MAX_TITLE = 120;

/**
 * Reads the address of the page.
 * @param {Pick<Location, 'search' | 'hash'>} location
 * @param {ReadOptions} [options]
 * @returns {Parsed}
 */
export function parseLocation(location, options = {}) {
	const params = new URLSearchParams(location.hash.replace(/^#/, ''));
	// The stream's address is a credential to read it: in the query, it has already reached this site's host.
	const query = new URLSearchParams(location.search);
	if (query.has('stream') || query.has('cast')) return { kind: 'invalid', reason: 'exposed-stream', ...look(params) };
	return parseParams(params, options);
}

/**
 * Reads the keys. A repeated key counts with its first value, as
 * `URLSearchParams.get` gives it.
 * @param {URLSearchParams} params form-decoded, so a `+` is a space
 * @param {ReadOptions} [options]
 * @returns {Parsed}
 */
export function parseParams(params, options = {}) {
	if ([...params.keys()].length === 0) return { kind: 'empty' };
	const shown = look(params);
	const title = cleanTitle(params.get('title') ?? '');
	const stream = params.get('stream');
	const cast = stream === null ? params.get('cast') : null;
	const value = stream ?? cast;
	if (value === null || value.trim() === '') {
		if (shown.embed) return { kind: 'view', view: { ...shown, ...(title ? { title } : {}) } };
		return { kind: 'invalid', reason: 'no-stream', ...shown };
	}
	const checked = checkStreamUrl(value, options);
	if (typeof checked === 'string') return { kind: 'invalid', reason: checked, ...shown };
	return { kind: 'view', view: { url: checked.toString(), host: checked.host, ...(cast !== null ? { cast: true } : {}), ...(title ? { title } : {}), ...shown } };
}

/**
 * How the page looks: `embed` and `theme`.
 * @param {URLSearchParams} params
 * @returns {{ embed: boolean, theme?: 'light' | 'dark' }}
 */
function look(params) {
	const theme = params.get('theme');
	return { embed: params.get('embed') === '1', ...(theme === 'light' || theme === 'dark' ? { theme } : {}) };
}

/**
 * A stream's address, or why the page won't read it: https, or http to this
 * device only on a page that is on this device too (`ReadOptions`); no user
 * name or password, which a fetch from this page would not send anyway; no
 * fragment, which is never sent.
 * @param {string} value
 * @param {ReadOptions} [options]
 * @returns {URL | Reason}
 */
export function checkStreamUrl(value, { local = false } = {}) {
	let url;
	try {
		url = new URL(value.trim());
	} catch {
		return 'bad-stream';
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'bad-stream';
	if (url.protocol === 'http:' && !isLoopback(url.hostname)) return 'insecure-stream';
	if (url.protocol === 'http:' && !local) return 'local-stream';
	if (url.username || url.password) return 'credentials-in-stream';
	url.hash = '';
	return url;
}

/**
 * Whether a host is this device, by a name the development server's CSP lets
 * the page read over http (scripts/build.mjs LOCAL_CONNECT_SOURCES):
 * localhost, a name under it, or 127.0.0.1. The hostname is as the URL parser gives it: lowercased, IPv4 in
 * dotted decimal.
 * @param {string} hostname
 */
export function isLoopback(hostname) {
	return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1';
}

/**
 * A title to show: on one line, without the controls that could reorder the
 * text around it (U+202A to U+202E, U+2066 to U+2069), at most `MAX_TITLE`
 * code points.
 * @param {string} title
 */
export function cleanTitle(title) {
	// eslint-disable-next-line no-control-regex
	const text = title.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
	const points = [...text];
	return points.length > MAX_TITLE ? `${points.slice(0, MAX_TITLE - 1).join('').trimEnd()}…` : text;
}

/**
 * The address of the page that shows a stream: the inverse of `parseLocation`.
 * @param {string} origin this site's origin, such as `https://terminal.apron.chat`
 * @param {{ url?: string, cast?: boolean, title?: string, embed?: boolean, theme?: 'light' | 'dark' }} view
 */
export function viewerUrl(origin, { url, cast, title, embed, theme }) {
	// Encoded as a component, but with `:` and `/` left readable: neither means anything in a fragment's keys.
	const encode = (/** @type {string} */ value) => encodeURIComponent(value).replace(/%3A/gi, ':').replace(/%2F/gi, '/');
	/** @type {string[]} */
	const keys = [];
	if (url) keys.push(`${cast ? 'cast' : 'stream'}=${encode(url)}`);
	if (title) keys.push(`title=${encode(title)}`);
	if (embed) keys.push('embed=1');
	if (theme) keys.push(`theme=${theme}`);
	return `${origin}/#${keys.join('&')}`;
}
