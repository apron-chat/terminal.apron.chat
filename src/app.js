// @ts-check
/**
 * The terminal.apron.chat page: reads the stream named in its own address
 * (src/stream.js), follows it (src/live.js) and draws it as a terminal would
 * (src/screen.js), as apron-web's terminal viewer does. Without a stream, it
 * says what it is and takes one pasted in.
 *
 * In an iframe, or with `embed=1`, it is a terminal embed in a chat message:
 * a slim bar and a screen that shows only the rows written, with no
 * scrollback, and it talks to the page around it (src/embed.js).
 *
 * All markup is built with DOM calls and `textContent`: the page's CSP
 * forbids the HTML sinks (Trusted Types), and a stream's bytes only ever
 * reach xterm's cells.
 */
import { Terminal } from './xterm.mjs';
import { followLiveText, liveTextDecoder } from './live.js';
import { INLINE_FIT, SCROLLBACK, TerminalScreen, VIEWER_FIT } from './screen.js';
import { checkStreamUrl, parseLocation, viewerUrl } from './stream.js';
import { isFramed, outputOf, READY, reportHeight } from './embed.js';

/** @typedef {import('./stream.js').Reason} Reason */
/** @typedef {import('./stream.js').View} View */

const REPOSITORY = 'https://github.com/apron-chat/terminal.apron.chat';
const PROTOCOL = 'https://github.com/shazow/apron/blob/main/PROTOCOL.md#486-embedterminal';
/** The page's own name, and the title when the stream has none. */
const NAME = 'Apron Embedded Terminal';

/** @type {Record<Reason, string>} */
const REASONS = {
	'no-stream': "This link doesn't say which stream to show.",
	'bad-stream': "The stream in this link isn't a web address.",
	'insecure-stream': 'This stream would be read without encryption (http://) from a server that is not on this device. Streams must use https://, except from localhost.',
	'credentials-in-stream': 'This stream has a user name or password in its address. This page reads streams without signing in, so it won\'t use it.',
	'exposed-stream': 'This link puts the stream in the query, which has already sent it to this site. Streams belong after the #, which stays in your browser.'
};

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const titleElement = /** @type {HTMLElement} */ (document.getElementById('title'));
const sourceElement = /** @type {HTMLElement} */ (document.getElementById('source'));
const statusElement = /** @type {HTMLElement} */ (document.getElementById('status'));
const copyButton = /** @type {HTMLButtonElement} */ (document.getElementById('copy'));
const openLink = /** @type {HTMLAnchorElement} */ (document.getElementById('open'));
const root = document.documentElement;
const framed = isFramed(window);

/** Ends what the page shows now: its stream's reading and screen. */
let teardown = () => {};
/** Takes a finished output from the parent page, for what the page shows now (src/embed.js). */
let receiveOutput = (/** @type {string} */ _output) => {};

/**
 * Makes an element. `attrs` are set with `setAttribute`, so they are values,
 * never code; strings among `children` become text nodes.
 * @param {string} tag
 * @param {Record<string, string | undefined>} [attrs]
 * @param {(Node | string | undefined | false)[]} children
 */
function h(tag, attrs = {}, ...children) {
	const element = document.createElement(tag);
	for (const [name, value] of Object.entries(attrs)) if (value !== undefined) element.setAttribute(name, value);
	for (const child of children) if (child) element.append(child);
	return element;
}

/**
 * Shows what the page is in the bar: a title, where it streams from, and a status.
 * @param {{ title?: string, host?: string, status?: { text: string, state: string, detail?: string } }} bar
 */
function setBar({ title, host, status }) {
	titleElement.textContent = title ?? NAME;
	document.title = title || host ? `${title ?? 'Terminal'}${host ? ` · ${host}` : ''}` : NAME;
	sourceElement.hidden = !host;
	sourceElement.replaceChildren(...(host ? ['Streaming from ', h('strong', {}, host)] : []));
	setStatus(status);
}

/** @param {{ text: string, state: string, detail?: string } | undefined} status */
function setStatus(status) {
	statusElement.hidden = !status;
	statusElement.textContent = status?.text ?? '';
	statusElement.dataset.state = status?.state ?? '';
	if (status?.detail) statusElement.title = status.detail;
	else statusElement.removeAttribute('title');
}

function render() {
	teardown();
	teardown = () => {};
	receiveOutput = () => {};
	copyButton.hidden = true;
	openLink.hidden = true;
	const parsed = parseLocation(location);
	const look = parsed.kind === 'view' ? parsed.view : parsed.kind === 'invalid' ? parsed : { embed: false };
	const embed = framed || look.embed;
	root.toggleAttribute('data-embed', embed);
	if (look.theme) root.dataset.theme = look.theme;
	else delete root.dataset.theme;
	if (parsed.kind === 'view') return showView(parsed.view, embed);
	setBar({});
	if (parsed.kind === 'invalid' && embed) {
		// In a chat message, no form: what is wrong, for whoever made the link.
		app.replaceChildren(h('p', { class: 'note' }, REASONS[parsed.reason]));
		return;
	}
	if (parsed.kind === 'empty') {
		app.replaceChildren(
			h('section', { class: 'card' },
				h('h2', {}, 'Watch a terminal'),
				h('p', {}, 'This page shows the output of a program, such as a build or a test run, live as it runs, the way an Apron chat shows a terminal. Links to it come from chat servers, for apps that can\'t show terminals themselves.'),
				h('p', { class: 'muted' }, 'The stream\'s address stays after the # in this page\'s address, so it never reaches this site. The page reads it straight from the chat server, without signing in.'),
				openForm(),
				h('p', { class: 'muted' }, h('a', { href: PROTOCOL }, 'How terminal embeds work'), ' · ', h('a', { href: REPOSITORY }, 'Source'))
			)
		);
		return;
	}
	app.replaceChildren(
		h('section', { class: 'card' },
			h('h2', {}, "Can't show this terminal"),
			h('p', {}, REASONS[parsed.reason]),
			openForm()
		)
	);
}

/** A box to paste a stream's address, or a terminal.apron.chat link, into. */
function openForm() {
	const field = /** @type {HTMLInputElement} */ (h('input', { class: 'field', type: 'url', name: 'stream', placeholder: 'https://chat.example/t/…', 'aria-label': "Stream's address", autocomplete: 'off', spellcheck: 'false', required: '' }));
	const error = h('p', { class: 'field-error', role: 'alert', hidden: '' });
	const form = h('form', { class: 'open' }, field, h('button', { class: 'button button-primary', type: 'submit' }, 'Open'));
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		const value = field.value.trim();
		// A whole link to this page: its fragment.
		if (value.startsWith(`${location.origin}/#`)) {
			location.hash = value.slice(location.origin.length + 2);
			return;
		}
		const checked = checkStreamUrl(value);
		if (typeof checked === 'string') {
			error.textContent = REASONS[checked];
			error.hidden = false;
			field.focus();
			return;
		}
		location.hash = viewerUrl('', { url: checked.toString() }).slice(2);
	});
	return h('div', { class: 'open-box' }, form, error);
}

/**
 * Follows the stream and draws it, until the address changes. In an embed,
 * a finished output from the parent page replaces it.
 * @param {View} view
 * @param {boolean} embed
 */
function showView(view, embed) {
	const { url, host } = view;
	/** @param {{ text: string, state: string, detail?: string }} [status] */
	const bar = (status) => setBar({ ...(view.title ? { title: view.title } : {}), ...(host ? { host } : {}), ...(status ? { status } : {}) });
	bar(url ? { text: 'Connecting…', state: 'connecting' } : undefined);
	if (embed && url) {
		// The full page, in a tab of its own, with scrollback.
		openLink.href = viewerUrl(location.origin, { url, ...(view.title ? { title: view.title } : {}), ...(view.theme ? { theme: view.theme } : {}) });
		openLink.hidden = false;
	}

	const screenHost = h('div', { class: 'screen', dir: 'ltr', 'data-testid': 'screen' });
	const note = h('p', { class: 'note', role: 'status', hidden: '' });
	const stage = h('div', { class: 'stage' }, screenHost, note);
	app.replaceChildren(stage);
	const screen = new TerminalScreen(Terminal, screenHost, embed ? { space: stage, fit: INLINE_FIT } : { space: stage, fit: VIEWER_FIT, scrollback: SCROLLBACK, keys: document });
	const controller = new AbortController();
	const copy = () => void copyText(screen.text());
	copyButton.addEventListener('click', copy);
	teardown = () => {
		controller.abort();
		copyButton.removeEventListener('click', copy);
		screen.dispose();
	};

	/** @param {string} [text] */
	const showNote = (text) => {
		note.hidden = !text;
		note.textContent = text ?? '';
	};

	// The embed's output, once a snapshot carries it: the stream has ended, and this is what was kept of it.
	receiveOutput = (output) => {
		controller.abort();
		screen.show(output);
		screenHost.hidden = false;
		copyButton.hidden = !output;
		showNote(output ? undefined : 'The program ended without any output.');
		bar({ text: 'Finished', state: 'ended', detail: 'The program\'s output has ended.' });
	};
	if (!url) return;

	let decoder = liveTextDecoder();
	/** Bytes the current response has brought. */
	let received = 0;
	void followLiveText(url, {
		start: () => {
			// A new response holds the text from its start: it replaces what was shown.
			decoder = liveTextDecoder();
			received = 0;
			screen.reset();
			showNote();
			bar({ text: 'Live', state: 'live' });
		},
		chunk: (bytes) => {
			received += bytes.byteLength;
			copyButton.hidden = false;
			screen.write(decoder.decode(bytes, { stream: true }));
		},
		retrying: ({ failures, delay, status }) => {
			const detail = `${status ? `The server answered ${status}.` : `Couldn't reach ${host}.`} Trying again in ${Math.round(delay / 1000)} s.`;
			bar({ text: failures > 2 ? `Can't reach ${host}` : 'Reconnecting…', state: 'connecting', detail });
		}
	}, controller.signal).then((outcome) => {
		if (outcome.how === 'aborted') return;
		if (outcome.how === 'ended') {
			screen.write(decoder.decode());
			bar({ text: 'Ended', state: 'ended', detail: 'The program\'s output has ended.' });
			if (!received) {
				screenHost.hidden = true;
				showNote('The stream ended without any output.');
			}
			return;
		}
		const { status } = outcome;
		const shown = received > 0;
		if (status === 404 || status === 410) {
			bar({ text: shown ? 'Ended' : 'Unavailable', state: shown ? 'ended' : 'failed', detail: `The server answered ${status}.` });
			screenHost.hidden = !shown;
			if (!shown) showNote('This stream has ended, or the link is wrong. Some chat servers stop serving a terminal once its output ends: its message in the chat shows the final output.');
			return;
		}
		bar({ text: 'Unavailable', state: 'failed', detail: `The server answered ${status}.` });
		screenHost.hidden = !shown;
		if (status === 403) showNote(`${host} won't let more people read this stream. Its message in the chat shows the output once it ends.`);
		else if (status === 401) showNote(`${host} wants to know who is reading this stream. This page reads streams without signing in.`);
		else showNote(`${host} refused to share this stream (${status}).`);
	});
}

/**
 * Copies text, saying so on the Copy button for a moment.
 * @param {string} text
 */
async function copyText(text) {
	let label = 'Copied';
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		label = "Couldn't copy";
	}
	copyButton.textContent = label;
	setTimeout(() => {
		copyButton.textContent = 'Copy';
	}, 1500);
}

addEventListener('hashchange', render);
addEventListener('message', (event) => {
	// Only the page that shows this one, from any origin: whoever chose to. Not in a frame, the parent is the page
	// itself, as for a native app's WebView that runs `window.postMessage(…)` in it.
	if (event.source !== window.parent) return;
	const output = outputOf(event.data);
	if (output !== undefined) receiveOutput(output);
});
if (framed) {
	const post = (/** @type {object} */ message) => window.parent.postMessage(message, '*');
	reportHeight(document.body, post);
	post({ type: READY });
}
render();
