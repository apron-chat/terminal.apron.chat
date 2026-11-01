// @ts-check
/**
 * The terminal.apron.chat page: reads the stream named in its own address
 * (src/stream.js), follows it (src/live.js) and draws it as a terminal would
 * (src/screen.js), as apron-web's terminal viewer does. Without a stream, it
 * says what it is and takes one pasted in.
 *
 * It also replays recordings in other tools' formats, and saves in them
 * (src/formats.js): an asciicast from `#cast=<url>`, or any file opened or
 * dropped on the page; the output it shows, as an asciicast or a VHS golden
 * file.
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
import { EMBED_SIZE, INLINE_FIT, SCROLLBACK, TerminalScreen, VIEWER_FIT } from './screen.js';
import { CAST_TYPE, dueUntil, parseRecording, readLimited, Recorder, replayTimes, writeCast, writeGolden } from './formats.js';
import { checkStreamUrl, cleanTitle, isLoopback, parseLocation, viewerUrl } from './stream.js';
import { isFramed, outputOf, READY, reportHeight, watchSight } from './embed.js';

/** @typedef {import('./stream.js').Reason} Reason */
/** @typedef {import('./stream.js').View} View */
/** @typedef {import('./formats.js').Recording} Recording */
/** @typedef {import('./screen.js').TerminalSize} TerminalSize */
/** @typedef {{ text: string, state: string, detail?: string }} Status */

const REPOSITORY = 'https://github.com/apron-chat/terminal.apron.chat';
const PROTOCOL = 'https://github.com/shazow/apron/blob/main/PROTOCOL.md#486-embedterminal';
/** The page's own name, and the title when the stream has none. */
const NAME = 'Apron Embedded Terminal';

/** @type {Record<Reason, string>} */
const REASONS = {
	'no-stream': "This link doesn't say which stream to show.",
	'bad-stream': "The stream in this link isn't a web address.",
	'insecure-stream': 'This stream would be read without encryption (http://). Streams must use https://.',
	'local-stream': 'This stream is on the device that opens it (http://localhost). Only a copy of this page running on that device can read it, such as one started with npm run dev.',
	'credentials-in-stream': 'This stream has a user name or password in its address. This page reads streams without signing in, so it won\'t use it.',
	'exposed-stream': 'This link puts the stream in the query, which has already sent it to this site. Streams belong after the #, which stays in your browser.'
};

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const titleElement = /** @type {HTMLElement} */ (document.getElementById('title'));
const sourceElement = /** @type {HTMLElement} */ (document.getElementById('source'));
const statusElement = /** @type {HTMLElement} */ (document.getElementById('status'));
const copyButton = /** @type {HTMLButtonElement} */ (document.getElementById('copy'));
const openLink = /** @type {HTMLAnchorElement} */ (document.getElementById('open'));
const skipButton = /** @type {HTMLButtonElement} */ (document.getElementById('skip'));
const saveMenu = /** @type {HTMLDetailsElement} */ (document.getElementById('save'));
const root = document.documentElement;
const brandLink = /** @type {HTMLAnchorElement} */ (document.querySelector('.brand'));
const framed = isFramed(window);
/** A copy of the page on this device, such as `npm run dev`'s, may read streams from it too (src/stream.js). */
const readOptions = { local: isLoopback(location.hostname) };
/**
 * How long a terminal out of sight (a hidden tab, or a frame scrolled out of
 * view) keeps reading before it stops, giving up its place among the
 * server's few readers of a text (apron-server-cloudflare allows 5 to 10).
 * It reads afresh once it is in sight again.
 */
const PAUSE_AFTER_MS = 15_000;
/** @param {object} message */
const post = (message) => window.parent.postMessage(message, '*');
/** The largest recording the page opens, from a file or a link: some 20 MB. */
const MAX_RECORDING = 20 * 1024 * 1024;

/** Ends what the page shows now: its stream's reading and screen. */
let teardown = () => {};
/** Takes a finished output from the parent page, for what the page shows now (src/embed.js). */
let receiveOutput = (/** @type {string} */ _output) => {};
/** What the page shows now, but for its theme: a change of theme alone doesn't start it afresh. */
let shownKey = '';
/**
 * What Save writes, for what the page shows now: its recording so far, and its screen's rows.
 * @type {{ title?: string, size: TerminalSize, recorded: () => Pick<Recording, 'events' | 'timestamp'>, rows: () => string[] } | undefined}
 */
let saving;

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
 * Shows what the page is in the bar: a title, where it comes from (`Streaming from` a host, by default), and a status.
 * @param {{ title?: string, host?: string, from?: string, status?: Status }} bar
 */
function setBar({ title, host, from = 'Streaming from', status }) {
	titleElement.textContent = title ?? NAME;
	document.title = title || host ? `${title ?? 'Terminal'}${host ? ` · ${host}` : ''}` : NAME;
	sourceElement.hidden = !host;
	sourceElement.replaceChildren(...(host ? [`${from} `, h('strong', {}, host)] : []));
	setStatus(status);
}

/** @param {Status | undefined} status */
function setStatus(status) {
	statusElement.hidden = !status;
	statusElement.textContent = status?.text ?? '';
	statusElement.dataset.state = status?.state ?? '';
	if (status?.detail) statusElement.title = status.detail;
	else statusElement.removeAttribute('title');
}

function render() {
	const parsed = parseLocation(location, readOptions);
	const look = parsed.kind === 'view' ? parsed.view : parsed.kind === 'invalid' ? parsed : { embed: false };
	if (look.theme) root.dataset.theme = look.theme;
	else delete root.dataset.theme;
	const { theme: _theme, ...rest } = look;
	const key = JSON.stringify([parsed.kind, parsed.kind === 'invalid' ? parsed.reason : '', rest]);
	if (key === shownKey) return;
	shownKey = key;
	clear();
	const embed = framed || look.embed;
	root.toggleAttribute('data-embed', embed);
	// In a chat message, a link opens beside it, never in its place.
	if (embed) {
		brandLink.target = '_blank';
		brandLink.rel = 'noopener';
	} else brandLink.removeAttribute('target');
	if (parsed.kind === 'view' && parsed.view.cast) void showCast(parsed.view, embed);
	else if (parsed.kind === 'view') showView(parsed.view, embed);
	else showMessage(parsed, embed);
	// Anything shown before is gone, an output sent in with it too: the parent sends it (again) on this.
	if (framed) post({ type: READY });
}

/** Ends what the page shows, and hides what belongs to it. */
function clear() {
	teardown();
	teardown = () => {};
	receiveOutput = () => {};
	saving = undefined;
	for (const control of [copyButton, openLink, skipButton, saveMenu]) control.hidden = true;
	saveMenu.open = false;
}

/**
 * Says what the page is, or what is wrong with its link.
 * @param {Exclude<import('./stream.js').Parsed, { kind: 'view' }>} parsed
 * @param {boolean} embed
 */
function showMessage(parsed, embed) {
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
				fileForm(),
				h('p', { class: 'muted' }, h('a', { href: PROTOCOL, target: '_blank', rel: 'noopener' }, 'How terminal embeds work'), ' · ', h('a', { href: REPOSITORY, target: '_blank', rel: 'noopener' }, 'Source'))
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

/** A button to open a recording from a file, which can be dropped on the page too. */
function fileForm() {
	const input = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: '.cast,.txt,.log,.ans,text/plain,application/x-asciicast', hidden: '' }));
	input.addEventListener('change', () => {
		const file = input.files?.[0];
		if (file) void openFile(file);
	});
	const button = h('button', { class: 'button', type: 'button' }, 'Open a file');
	button.addEventListener('click', () => input.click());
	return h('p', { class: 'muted open-file' }, button, input, ' or drop one here: an asciinema recording (.cast) or a terminal\'s output. It stays in your browser.');
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
		const checked = checkStreamUrl(value, readOptions);
		if (typeof checked === 'string') {
			error.textContent = REASONS[checked];
			error.hidden = false;
			field.focus();
			return;
		}
		// An address that ends in .cast is a recording to replay.
		location.hash = viewerUrl('', { url: checked.toString(), cast: checked.pathname.endsWith('.cast') }).slice(2);
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

	const { screen, screenHost, stage, showNote, dispose } = mountScreen(embed, EMBED_SIZE);
	const recorder = new Recorder();
	saving = { ...(view.title ? { title: view.title } : {}), size: EMBED_SIZE, recorded: () => recorder.recorded, rows: () => screen.screenRows() };
	/** Set once nothing more will come: the output ended, the server refused it, or the parent sent the output. */
	let done = false;
	/** @type {AbortController | undefined} The reading now, if any. */
	let reading;
	const stopReading = () => {
		reading?.abort();
		reading = undefined;
	};
	let unwatch = () => {};
	teardown = () => {
		stopReading();
		unwatch();
		dispose();
	};

	// The embed's output, once a snapshot carries it: the stream has ended, and this is what was kept of it.
	receiveOutput = (output) => {
		done = true;
		stopReading();
		screen.show(output);
		recorder.replace(output);
		screenHost.hidden = false;
		copyButton.hidden = !output;
		saveMenu.hidden = embed || !output;
		showNote(output ? undefined : 'The program ended without any output.');
		bar({ text: 'Finished', state: 'ended', detail: 'The program\'s output has ended.' });
	};
	if (!url) return;

	let decoder = liveTextDecoder();
	/** Bytes the last response brought: whether anything is shown. */
	let received = 0;
	const follow = () => {
		if (done || reading) return;
		const controller = new AbortController();
		reading = controller;
		void followLiveText(url, {
			start: () => {
				// A new response holds the text from its start: it replaces what was shown.
				decoder = liveTextDecoder();
				received = 0;
				recorder.reset();
				screen.reset();
				showNote();
				bar({ text: 'Live', state: 'live' });
			},
			chunk: (bytes) => {
				received += bytes.byteLength;
				copyButton.hidden = false;
				saveMenu.hidden = embed;
				const text = decoder.decode(bytes, { stream: true });
				recorder.add(text);
				screen.write(text);
			},
			retrying: ({ failures, delay, status }) => {
				const wait = `Trying again in ${Math.round(delay / 1000)} s.`;
				if (status === 429) bar({ text: 'Too many readers', state: 'connecting', detail: `${host} has as many readers of this stream as it allows. ${wait}` });
				else if (status) bar({ text: failures > 2 ? `${host} answered ${status}` : 'Reconnecting…', state: 'connecting', detail: `The server answered ${status}. ${wait}` });
				else bar({ text: failures > 2 ? `Can't reach ${host}` : 'Reconnecting…', state: 'connecting', detail: `Couldn't reach ${host}. ${wait}` });
			}
		}, controller.signal).then((outcome) => {
			if (outcome.how === 'aborted') return;
			reading = undefined;
			done = true;
			if (outcome.how === 'ended') {
				const rest = decoder.decode();
				recorder.add(rest);
				screen.write(rest);
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
			if (status === 403) showNote(`${host} won't let this stream be read any more: it may have been read as often as the server allows. Its message in the chat shows the output once it ends.`);
			else if (status === 401) showNote(`${host} wants to know who is reading this stream. This page reads streams without signing in.`);
			else showNote(`${host} refused to share this stream (${status}).`);
		});
	};
	// Out of sight for a while, it stops reading; back in sight, it reads afresh, replacing what it showed.
	unwatch = watchSight(stage, (inSight) => {
		if (inSight) {
			if (!done && !reading) bar({ text: 'Connecting…', state: 'connecting' });
			follow();
		} else if (!done && reading) {
			stopReading();
			bar({ text: 'Paused', state: 'connecting', detail: 'Out of sight, it stops reading. It reads again once it is in sight.' });
		}
	}, PAUSE_AFTER_MS);
	follow();
}

/**
 * A screen of `size` in the page, as the full page or an embed shows it, with Copy wired to it.
 * @param {boolean} embed
 * @param {TerminalSize} size
 */
function mountScreen(embed, size) {
	const screenHost = h('div', { class: 'screen', dir: 'ltr', 'data-testid': 'screen' });
	const note = h('p', { class: 'note', role: 'status', hidden: '' });
	const stage = h('div', { class: 'stage' }, screenHost, note);
	app.replaceChildren(stage);
	const screen = new TerminalScreen(Terminal, screenHost, embed ? { space: stage, fit: INLINE_FIT, size } : { space: stage, fit: VIEWER_FIT, scrollback: SCROLLBACK, keys: document, size });
	const copy = () => void copyText(screen.text());
	copyButton.addEventListener('click', copy);
	return {
		screen,
		screenHost,
		stage,
		/** @param {string} [text] */
		showNote: (text) => {
			note.hidden = !text;
			note.textContent = text ?? '';
		},
		dispose: () => {
			copyButton.removeEventListener('click', copy);
			screen.dispose();
		}
	};
}

/**
 * Loads the recording at `view.url` (`#cast=`), and replays it.
 * @param {View} view
 * @param {boolean} embed
 */
async function showCast(view, embed) {
	const url = /** @type {string} */ (view.url);
	const host = /** @type {string} */ (view.host);
	const key = shownKey;
	const from = 'Recording from';
	setBar({ ...(view.title ? { title: view.title } : {}), host, from, status: { text: 'Loading…', state: 'connecting' } });
	app.replaceChildren();
	if (embed) {
		// The full page, in a tab of its own, with Save.
		openLink.href = viewerUrl(location.origin, { url, cast: true, ...(view.title ? { title: view.title } : {}), ...(view.theme ? { theme: view.theme } : {}) });
		openLink.hidden = false;
	}
	const controller = new AbortController();
	teardown = () => controller.abort();
	/** Whether the page has moved on to something else since. */
	const stale = () => controller.signal.aborted || shownKey !== key;
	/** @param {string} text */
	const fail = (text) => {
		if (stale()) return;
		setBar({ ...(view.title ? { title: view.title } : {}), host, from, status: { text: 'Unavailable', state: 'failed' } });
		app.replaceChildren(h('p', { class: 'note' }, text));
	};
	const tooLarge = 'This recording is too large to open here.';
	let text;
	try {
		const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
		if (!response.ok) return fail(`${host} answered ${response.status} for this recording.`);
		if (Number(response.headers.get('Content-Length')) > MAX_RECORDING) {
			void response.body?.cancel().catch(() => {});
			return fail(tooLarge);
		}
		// Without a Content-Length, or with a wrong one, it stops reading past the bound.
		text = await readLimited(response.body, MAX_RECORDING);
	} catch {
		return fail(`Couldn't load this recording from ${host}. It may not let other sites read it.`);
	}
	if (text === undefined) return fail(tooLarge);
	if (stale()) return;
	/** @type {Recording} */
	let recording;
	try {
		recording = parseRecording(text);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
	const title = view.title ?? cleanTitle(recording.title ?? '');
	showRecording(recording, { ...(title ? { title } : {}), host, from }, embed);
}

/**
 * Opens a recording from a file the viewer chose or dropped: it stays in the browser.
 * @param {File} file
 */
async function openFile(file) {
	if (file.size > MAX_RECORDING) {
		window.alert('This file is too large to open here.');
		return;
	}
	/** @type {Recording} */
	let recording;
	try {
		recording = parseRecording(await file.text());
	} catch (error) {
		window.alert(error instanceof Error ? error.message : String(error));
		return;
	}
	// The address no longer says what the page shows; going back to a link shows it again.
	if (location.hash) history.pushState(null, '', location.pathname);
	clear();
	shownKey = `file:${file.name}`;
	// In a frame, the compact layout still.
	root.toggleAttribute('data-embed', framed);
	const name = cleanTitle(file.name) || 'a file';
	showRecording(recording, { title: cleanTitle(recording.title ?? '') || name, host: name, from: 'Opened from' }, framed);
}

/**
 * Shows a recording: an asciicast replayed at its own pace, with pauses
 * capped and Skip to its end; output, at once.
 * @param {Recording} recording
 * @param {{ title?: string, host: string, from: string }} source
 * @param {boolean} embed
 */
function showRecording(recording, { title, host, from }, embed) {
	const { screen, showNote, dispose } = mountScreen(embed, recording.size);
	saving = { ...(title ? { title } : {}), size: recording.size, recorded: () => recording, rows: () => screen.screenRows() };
	/** @param {Status} status */
	const bar = (status) => setBar({ ...(title ? { title } : {}), host, from, status });
	const detail = `${recording.size.cols}×${recording.size.rows}`;
	const finish = () => {
		skipButton.hidden = true;
		bar({ text: recording.format === 'asciicast' ? 'Replayed' : 'Output', state: 'ended', detail });
		const empty = !recording.events.some(([, text]) => text);
		copyButton.hidden = empty;
		saveMenu.hidden = embed || empty;
		if (empty) showNote('This recording has no output.');
	};
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let timer;
	/** The first event not yet shown. */
	let next = 0;
	const skip = () => {
		clearTimeout(timer);
		screen.write(recording.events.slice(next).map(([, text]) => text).join(''));
		next = recording.events.length;
		finish();
	};
	skipButton.addEventListener('click', skip);
	teardown = () => {
		clearTimeout(timer);
		skipButton.removeEventListener('click', skip);
		dispose();
	};
	if (recording.format !== 'asciicast' || recording.events.length < 2) return skip();
	const times = replayTimes(recording);
	skipButton.hidden = false;
	copyButton.hidden = false;
	bar({ text: 'Replaying', state: 'live', detail });
	// Against the clock, not a timer per event: each tick shows every event that is due, in one write, so many
	// events close together (or a tab that held its timers back) don't fall behind.
	const started = performance.now();
	const tick = () => {
		const elapsed = performance.now() - started;
		const due = dueUntil(times, next, elapsed);
		if (due > next) {
			screen.write(recording.events.slice(next, due).map(([, text]) => text).join(''));
			next = due;
		}
		if (next >= recording.events.length) return finish();
		timer = setTimeout(tick, Math.max(0, times[next] - elapsed));
	};
	timer = setTimeout(tick, times[0]);
}

/**
 * Saves what the page shows in a format of another tool's: an asciicast
 * (version 3) of the output so far, with its timing, or a VHS golden file of
 * the screen as it is.
 * @param {string} format `cast` or `golden`
 */
function save(format) {
	if (!saving) return;
	const name = (saving.title ?? 'terminal').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'terminal';
	if (format === 'cast') {
		const { events, timestamp } = saving.recorded();
		download(`${name}.cast`, CAST_TYPE, writeCast({ size: saving.size, events, ...(saving.title ? { title: saving.title } : {}), ...(timestamp !== undefined ? { timestamp } : {}) }));
	} else {
		download(`${name}.txt`, 'text/plain', writeGolden(saving.rows()));
	}
}

/**
 * Hands the viewer a file to save.
 * @param {string} name
 * @param {string} type
 * @param {string} text
 */
function download(name, type, text) {
	const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
	const link = h('a', { href: url, download: name, hidden: '' });
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
// Going back to the link after opening a file shows it again.
addEventListener('popstate', () => {
	// Only after a file: the address didn't say what it showed. A change of fragment (popstate fires for it too, in
	// some browsers) is render's to compare, so a change of theme alone keeps what is shown.
	if (shownKey.startsWith('file:')) shownKey = '';
	render();
});
saveMenu.addEventListener('click', (event) => {
	const item = /** @type {HTMLElement | null} */ (event.target instanceof Element ? event.target.closest('[data-format]') : null);
	if (!item) return;
	save(item.dataset.format ?? '');
	saveMenu.open = false;
});
// A file dropped on the full page opens as a recording; a page in a chat message takes none.
addEventListener('dragover', (event) => {
	if (framed || !event.dataTransfer?.types.includes('Files')) return;
	event.preventDefault();
	root.dataset.dropping = '';
});
addEventListener('dragleave', (event) => {
	if (!event.relatedTarget) delete root.dataset.dropping;
});
addEventListener('drop', (event) => {
	delete root.dataset.dropping;
	const file = event.dataTransfer?.files[0];
	if (framed || !file) return;
	event.preventDefault();
	void openFile(file);
});

addEventListener('message', (event) => {
	// Only the page that shows this one, from any origin: whoever chose to. Not in a frame, the parent is the page
	// itself, as for a native app's WebView that runs `window.postMessage(…)` in it.
	if (event.source !== window.parent) return;
	const output = outputOf(event.data);
	if (output !== undefined) receiveOutput(output);
});
render();
// After the first render, so the first height is the content's, not the frame's.
if (framed) reportHeight(document.body, post);
