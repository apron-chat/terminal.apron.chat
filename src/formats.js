// @ts-check
/**
 * Recordings in the formats of tools people already use, so a terminal from
 * a chat can be replayed, shared and tested elsewhere:
 *
 * - asciicast version 3, asciinema's recordings
 *   (https://docs.asciinema.org/manual/asciicast/v3/), read and written: the
 *   output with its timing, to replay here or with asciinema, such as for a
 *   bug report. Output events (`o`) are kept; input, markers, resizes and
 *   exits are skipped, their time added to the next output.
 * - VHS golden files (charmbracelet/vhs, `Output golden.txt`), written: the
 *   screen as text, each row without trailing spaces, then a line of 80
 *   `─`, to compare in tests.
 * - Anything else read is a terminal's output, as a finished embed's
 *   `output` is.
 */
import { EMBED_SIZE, keepLast, OUTPUT_KEEP, TERMINAL_COLS } from './screen.js';

/** @typedef {import('./screen.js').TerminalSize} TerminalSize */

/** Output, and the seconds since the output before it (or since the start). */
/** @typedef {[interval: number, text: string]} OutputEvent */

/**
 * @typedef {object} Recording
 * @property {'asciicast' | 'output'} format what it was read from
 * @property {TerminalSize} size the terminal it was recorded in
 * @property {OutputEvent[]} events its output, in order
 * @property {string} [title]
 * @property {number} [timestamp] when it started, in Unix seconds
 * @property {number} [idleLimit] the longest pause to replay, in seconds, as asciinema's idle_time_limit
 */

/** The largest terminal a recording may ask for: beyond any real screen, and bounded, as xterm.js allocates every cell. */
export const MAX_SIZE = /** @type {TerminalSize} */ ({ cols: 500, rows: 200 });

/** The longest pause replayed when a recording sets none, in seconds. */
export const DEFAULT_IDLE_LIMIT = 2;

/** The line after each frame of a VHS golden file. */
export const GOLDEN_SEPARATOR = '─'.repeat(TERMINAL_COLS);

/** The type asciinema serves .cast files as. */
export const CAST_TYPE = 'application/x-asciicast';

/**
 * Reads a recording: an asciicast of version 3, or else a terminal's output.
 * Throws for an asciicast of another version, or one that breaks the format.
 * @param {string} text
 * @returns {Recording}
 */
export function parseRecording(text) {
	const body = text.replace(/^﻿/, '');
	return (/^\s*\{/.test(body) ? parseCast(body) : undefined) ?? { format: 'output', size: EMBED_SIZE, events: [[0, text]] };
}

/**
 * An asciicast of version 3, or undefined for text that isn't an asciicast:
 * a header line, then a line per event, `[interval, code, data]`, each
 * interval in seconds from the event before.
 * @param {string} text
 * @returns {Recording | undefined}
 */
export function parseCast(text) {
	const lines = text.split(/\r?\n/);
	/** @type {unknown} */
	let header;
	try {
		header = JSON.parse(lines[0]);
	} catch {
		return undefined;
	}
	if (!isObject(header) || typeof header.version !== 'number') return undefined;
	if (header.version !== 3) {
		throw new Error(`This is an asciicast of version ${header.version}. This page opens version 3, which asciinema 3 records; \`asciinema convert\` converts older ones.`);
	}
	const term = isObject(header.term) ? header.term : {};
	const size = sizeOf(term.cols, term.rows);
	/** @type {OutputEvent[]} */
	const events = [];
	let carried = 0;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line || line.startsWith('#')) continue;
		/** @type {unknown} */
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			throw new Error(`Line ${i + 1} of the asciicast isn't JSON.`);
		}
		if (!Array.isArray(event) || event.length < 3 || typeof event[0] !== 'number' || !Number.isFinite(event[0]) || typeof event[1] !== 'string') {
			throw new Error(`Line ${i + 1} of the asciicast isn't an event.`);
		}
		const interval = Math.max(0, event[0]);
		if (event[1] !== 'o' || typeof event[2] !== 'string') {
			carried += interval;
			continue;
		}
		events.push([interval + carried, event[2]]);
		carried = 0;
	}
	return {
		format: 'asciicast',
		size,
		events,
		...(typeof header.title === 'string' && header.title ? { title: header.title } : {}),
		...(typeof header.timestamp === 'number' ? { timestamp: header.timestamp } : {}),
		...(typeof header.idle_time_limit === 'number' && header.idle_time_limit > 0 ? { idleLimit: header.idle_time_limit } : {})
	};
}

/**
 * A terminal size within bounds, from a recording's columns and rows.
 * @param {unknown} cols
 * @param {unknown} rows
 * @returns {TerminalSize}
 */
function sizeOf(cols, rows) {
	const valid = (/** @type {unknown} */ n, /** @type {number} */ max) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max;
	if (!valid(cols, MAX_SIZE.cols) || !valid(rows, MAX_SIZE.rows)) {
		throw new Error(`The recording's terminal size isn't one that can be shown (up to ${MAX_SIZE.cols} by ${MAX_SIZE.rows}).`);
	}
	return { cols: /** @type {number} */ (cols), rows: /** @type {number} */ (rows) };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A recording as an asciicast of version 3: a header line, then a line per
 * output event, its interval in seconds rounded to milliseconds without the
 * rounding adding up over a long recording.
 * @param {Pick<Recording, 'size' | 'events' | 'title' | 'timestamp'>} recording
 */
export function writeCast({ size, events, title, timestamp }) {
	const header = {
		version: 3,
		term: { cols: size.cols, rows: size.rows, type: 'xterm-256color' },
		...(timestamp !== undefined ? { timestamp: Math.floor(timestamp) } : {}),
		...(title ? { title } : {})
	};
	const lines = [JSON.stringify(header)];
	// Each interval is the difference of rounded times since the start, so their errors don't accumulate.
	let exact = 0;
	let written = 0;
	for (const [interval, text] of events) {
		exact += interval;
		const at = Math.round(exact * 1000);
		lines.push(JSON.stringify([(at - written) / 1000, 'o', text]));
		written = at;
	}
	return `${lines.join('\n')}\n`;
}

/**
 * A screen as one frame of a VHS golden file: each row, without trailing
 * spaces, then the separator.
 * @param {string[]} rows every row of the screen, from the top
 */
export function writeGolden(rows) {
	return `${rows.map((row) => `${row.trimEnd()}\n`).join('')}${GOLDEN_SEPARATOR}\n`;
}

/**
 * The pauses to replay a recording with, in ms: each event's interval, but
 * none longer than its idle limit, as asciinema replays it.
 * @param {Pick<Recording, 'events' | 'idleLimit'>} recording
 */
export function replayDelays({ events, idleLimit = DEFAULT_IDLE_LIMIT }) {
	return events.map(([interval]) => Math.round(Math.min(interval, idleLimit) * 1000));
}

/**
 * Records output as it arrives, to save as an asciicast. Past a bound, it
 * keeps what a terminal would need to show the screen: the last part of the
 * output, cut as servers cut a terminal's, as one event.
 */
export class Recorder {
	/** @type {OutputEvent[]} */
	#events = [];
	#length = 0;
	/** @type {number | undefined} */
	#last;
	/** @type {number | undefined} */
	#started;
	/** @type {() => number} */
	#now;
	#limit;

	/**
	 * @param {{ now?: () => number, limit?: number }} [options] the clock in ms, and how much text it keeps before it cuts
	 */
	constructor({ now = () => Date.now(), limit = 4 * OUTPUT_KEEP } = {}) {
		this.#now = now;
		this.#limit = limit;
	}

	/** Starts afresh, such as for a reconnect's new response, which holds the text from its start. */
	reset() {
		this.#events = [];
		this.#length = 0;
		this.#last = undefined;
		this.#started = undefined;
	}

	/** @param {string} text the next output */
	add(text) {
		if (!text) return;
		const now = this.#now();
		this.#started ??= now;
		this.#events.push([(now - (this.#last ?? now)) / 1000, text]);
		this.#last = now;
		this.#length += text.length;
		if (this.#length > this.#limit) {
			const kept = keepLast(this.#events.map(([, t]) => t).join(''), OUTPUT_KEEP);
			this.#events = [[0, kept]];
			this.#length = kept.length;
		}
	}

	/** Replaces it with `output`, all at once, such as a finished embed's. */
	replace(/** @type {string} */ output) {
		this.reset();
		this.add(output);
	}

	/** What it recorded, as a recording's events and its start in Unix seconds. */
	get recorded() {
		return { events: this.#events.map(([i, t]) => /** @type {OutputEvent} */ ([i, t])), ...(this.#started !== undefined ? { timestamp: this.#started / 1000 } : {}) };
	}
}
