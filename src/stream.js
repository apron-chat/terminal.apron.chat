// @ts-check
/**
 * Reads the page's own address: which terminal stream to show.
 *
 *   https://terminal.apron.chat/#stream=<url>&title=<title>
 *
 * `stream` is the `url` of a `terminal` embed (PROTOCOL.md §4.8.6), the live
 * text a chat server serves. Percent-encode it when it has a `&`, `#`, `+` or
 * `%` of its own. `title` is optional: the embed's `title`, such as the
 * command. A repeated key counts with its first value.
 *
 * The keys belong in the fragment, so the stream's address, which anyone who
 * has it can read, never reaches this site's host.
 */

/** @typedef {'no-stream' | 'bad-stream' | 'insecure-stream' | 'credentials-in-stream' | 'exposed-stream'} Reason */

/**
 * @typedef {object} Stream
 * @property {string} url the address to read, as the URL parser writes it
 * @property {string} host where it is read from, to show
 * @property {string} [title] what it is, such as the command that writes it
 */

/** @typedef {{ kind: 'empty' } | { kind: 'invalid', reason: Reason } | { kind: 'stream', stream: Stream }} Parsed */

/** The longest title shown, in code points. Longer ones are cut, with an ellipsis. */
export const MAX_TITLE = 120;

/**
 * Reads the address of the page.
 * @param {Pick<Location, 'search' | 'hash'>} location
 * @returns {Parsed}
 */
export function parseLocation(location) {
	// The stream's address is a credential to read it: in the query, it has already reached this site's host.
	if (new URLSearchParams(location.search).has('stream')) return { kind: 'invalid', reason: 'exposed-stream' };
	return parseParams(new URLSearchParams(location.hash.replace(/^#/, '')));
}

/**
 * Reads the keys. A repeated key counts with its first value, as
 * `URLSearchParams.get` gives it.
 * @param {URLSearchParams} params form-decoded, so a `+` is a space
 * @returns {Parsed}
 */
export function parseParams(params) {
	if ([...params.keys()].length === 0) return { kind: 'empty' };
	const value = params.get('stream');
	if (value === null || value.trim() === '') return { kind: 'invalid', reason: 'no-stream' };
	const checked = checkStreamUrl(value);
	if (typeof checked === 'string') return { kind: 'invalid', reason: checked };
	const title = cleanTitle(params.get('title') ?? '');
	return { kind: 'stream', stream: { url: checked.toString(), host: checked.host, ...(title ? { title } : {}) } };
}

/**
 * A stream's address, or why the page won't read it: https, or http to this
 * device only; no user name or password, which a fetch from this page would
 * not send anyway; no fragment, which is never sent.
 * @param {string} value
 * @returns {URL | Reason}
 */
export function checkStreamUrl(value) {
	let url;
	try {
		url = new URL(value.trim());
	} catch {
		return 'bad-stream';
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'bad-stream';
	if (url.protocol === 'http:' && !isLoopback(url.hostname)) return 'insecure-stream';
	if (url.username || url.password) return 'credentials-in-stream';
	url.hash = '';
	return url;
}

/**
 * Whether a host is this device, by a name the page's CSP lets it read over
 * http (scripts/build.mjs CONNECT_SOURCES): localhost, a name under it, or
 * 127.0.0.1. The hostname is as the URL parser gives it: lowercased, IPv4 in
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
	const text = title.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim();
	const points = [...text];
	return points.length > MAX_TITLE ? `${points.slice(0, MAX_TITLE - 1).join('').trimEnd()}…` : text;
}

/**
 * The address of the page that shows `stream`: the inverse of `parseLocation`.
 * @param {string} origin this site's origin, such as `https://terminal.apron.chat`
 * @param {{ url: string, title?: string }} stream
 */
export function viewerUrl(origin, { url, title }) {
	// Encoded as a component, but with `:` and `/` left readable: neither means anything in a fragment's keys.
	const encode = (/** @type {string} */ value) => encodeURIComponent(value).replace(/%3A/gi, ':').replace(/%2F/gi, '/');
	return `${origin}/#stream=${encode(url)}${title ? `&title=${encode(title)}` : ''}`;
}
