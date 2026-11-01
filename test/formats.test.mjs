import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IDLE_LIMIT, dueUntil, parseCast, parseRecording, readLimited, Recorder, replayTimes, writeCast } from '../src/formats.js';
import { keepLast, OUTPUT_KEEP } from '../src/screen.js';

const HEADER = JSON.stringify({ version: 3, term: { cols: 80, rows: 24 } });

test('asciicast v3: intervals from the event before, output only, comments skipped', () => {
	const cast = [
		JSON.stringify({ version: 3, term: { cols: 120, rows: 30, type: 'xterm-256color' }, timestamp: 1730000000, title: 'demo', idle_time_limit: 1.5 }),
		'# a comment',
		'[0.25, "o", "hello "]',
		'[0.5, "i", "x"]',
		'[0.5, "m", "chapter"]',
		'[0.1, "o", "world\\r\\n"]',
		'[0.2, "r", "100x20"]',
		'[0.3, "x", "0"]',
		''
	].join('\n');
	assert.deepEqual(parseRecording(cast), {
		format: 'asciicast',
		size: { cols: 120, rows: 30 },
		// The skipped events' time goes to the next output.
		events: [[0.25, 'hello '], [1.1, 'world\r\n']],
		title: 'demo',
		timestamp: 1730000000,
		idleLimit: 1.5
	});
});

test('asciicasts that break the format say how', () => {
	assert.throws(() => parseCast('{"version": 3, "term": {"cols": 80, "rows": 24}}\nnot json\n[0.5, "o", "a"]'), /Line 2 of the asciicast isn't JSON/);
	assert.throws(() => parseCast('{"version": 3, "term": {"cols": 80, "rows": 24}}\n{"a": 1}'), /Line 2 of the asciicast isn't an event/);
	assert.throws(() => parseCast('{"version": 3, "term": {"cols": 9000, "rows": 24}}'), /terminal size/);
	assert.throws(() => parseCast('{"version": 3, "term": {}}'), /terminal size/);
	// Older versions say how to convert them.
	assert.throws(() => parseCast('{"version": 2, "width": 80, "height": 24}'), /version 2.*asciinema convert/);
	assert.throws(() => parseCast('{"version": 1, "width": 80, "height": 24, "stdout": []}'), /version 1/);
	// Not an asciicast at all: undefined, and parseRecording reads it as output.
	assert.equal(parseCast('{"hello": "world"}'), undefined);
	assert.equal(parseRecording('{"hello": "world"}').format, 'output');
});

test('anything that is not an asciicast is output', () => {
	assert.deepEqual(parseRecording('plain \x1b[32moutput\x1b[0m'), { format: 'output', size: { cols: 80, rows: 40 }, events: [[0, 'plain \x1b[32moutput\x1b[0m']] });
});

test('writeCast writes asciicast v3 that parseCast reads back', () => {
	const recording = { size: { cols: 80, rows: 40 }, title: 'make test', timestamp: 1730000000.7, events: /** @type {[number, string][]} */ ([[0, '$ make\r\n'], [0.1234, '\x1b[32mok\x1b[0m'], [1.5, ' done']]) };
	const cast = writeCast(recording);
	const [header, ...events] = cast.trimEnd().split('\n').map((line) => JSON.parse(line));
	assert.deepEqual(header, { version: 3, term: { cols: 80, rows: 40, type: 'xterm-256color' }, timestamp: 1730000000, title: 'make test' });
	assert.deepEqual(events, [[0, 'o', '$ make\r\n'], [0.123, 'o', '\x1b[32mok\x1b[0m'], [1.5, 'o', ' done']]);
	assert.deepEqual(parseCast(cast)?.events, [[0, '$ make\r\n'], [0.123, '\x1b[32mok\x1b[0m'], [1.5, ' done']]);
});

test('writeCast rounds without the error adding up', () => {
	const events = /** @type {[number, string][]} */ (Array.from({ length: 1000 }, () => [0.0004, 'x']));
	const written = writeCast({ size: { cols: 80, rows: 40 }, events }).trimEnd().split('\n').slice(1).map((line) => JSON.parse(line)[0]);
	// 1000 × 0.4 ms is 0.4 s; rounding each to a millisecond alone would give 0.
	assert.equal(Math.round(written.reduce((a, b) => a + b, 0) * 1000), 400);
});

test('replay times add up the pauses, each capped at the idle limit', () => {
	assert.deepEqual(replayTimes({ events: [[0.1, 'a'], [30, 'b'], [0.2, 'c']] }), [100, 100 + DEFAULT_IDLE_LIMIT * 1000, 2300]);
	assert.deepEqual(replayTimes({ events: [[0.1, 'a'], [30, 'b']], idleLimit: 0.5 }), [100, 600]);
	assert.deepEqual(replayTimes({ events: [] }), []);
});

test('a replay shows every event that is due at once', () => {
	const times = [0, 0, 0, 100, 100, 250];
	assert.equal(dueUntil(times, 0, 0), 3);
	assert.equal(dueUntil(times, 3, 99), 3);
	assert.equal(dueUntil(times, 3, 100), 5);
	// Behind (a tab that held its timers back): everything due so far.
	assert.equal(dueUntil(times, 0, 1000), times.length);
	assert.equal(dueUntil(times, times.length, 1000), times.length);
	// 2,000 events with no pause between them are all due at the start, for one write.
	const many = replayTimes({ events: Array.from({ length: 2000 }, () => /** @type {[number, string]} */ ([0, 'x'])) });
	assert.equal(dueUntil(many, 0, 0), 2000);
});

test('the recorder keeps output with its timing, and cuts it past its bound', () => {
	let now = 1_000_000;
	const recorder = new Recorder({ now: () => now, limit: OUTPUT_KEEP * 2 });
	recorder.add('a');
	now += 250;
	recorder.add('b');
	assert.deepEqual(recorder.recorded, { events: [[0, 'a'], [0.25, 'b']], timestamp: 1000 });
	recorder.reset();
	assert.deepEqual(recorder.recorded, { events: [] });
	// Past the bound (twice OUTPUT_KEEP here): the last OUTPUT_KEEP, from its first control character.
	recorder.add('x'.repeat(OUTPUT_KEEP + 20));
	recorder.add('\r\n' + 'y'.repeat(OUTPUT_KEEP - 10));
	const { events } = recorder.recorded;
	assert.equal(events.length, 1);
	assert.ok(events[0][1].startsWith('\r\n') && events[0][1].length <= OUTPUT_KEEP);
	recorder.replace('final');
	assert.deepEqual(recorder.recorded.events, [[0, 'final']]);
});

test('the recorder starts its recording again where it cuts it', () => {
	let now = 1_000_000;
	const recorder = new Recorder({ now: () => now, limit: OUTPUT_KEEP * 2 });
	recorder.add('x'.repeat(OUTPUT_KEEP + 20));
	now += 5000;
	recorder.add('\r\n' + 'y'.repeat(OUTPUT_KEEP - 10));
	const { events: [kept], timestamp } = recorder.recorded;
	// The kept text is shown all at once, at the time of the cut.
	assert.equal(kept[0], 0);
	assert.equal(timestamp, 1005);
	now += 250;
	recorder.add('z');
	assert.deepEqual(recorder.recorded, { events: [kept, [0.25, 'z']], timestamp: 1005 });
});

test('an interrupted recording opens without its cut-off last line', () => {
	const cast = `${HEADER}\n[0.1, "o", "a"]\n[0.2, "o", "b"]\n[0.3, "o", "c`;
	assert.deepEqual(parseCast(cast)?.events, [[0.1, 'a'], [0.2, 'b']]);
	// With trailing blank lines too.
	assert.deepEqual(parseCast(`${cast}\n\n`)?.events, [[0.1, 'a'], [0.2, 'b']]);
	// A broken line before the last is still an error.
	assert.throws(() => parseCast(`${HEADER}\n[0.1, "o", "a"]\n[0.2, "o", "b\n[0.3, "o", "c"]`), /Line 3 of the asciicast isn't JSON/);
	// A last line that is JSON but not an event is too: it wasn't cut off.
	assert.throws(() => parseCast(`${HEADER}\n[0.1, "o", "a"]\n{"a": 1}`), /Line 3 of the asciicast isn't an event/);
});

test('asciicasts with CRLF line ends, or a byte order mark', () => {
	const lines = [HEADER, '[0.5, "o", "a\\r\\n"]', '[0.25, "o", "b"]', ''];
	const expected = { format: 'asciicast', size: { cols: 80, rows: 24 }, events: [[0.5, 'a\r\n'], [0.25, 'b']] };
	assert.deepEqual(parseRecording(lines.join('\r\n')), expected);
	assert.deepEqual(parseRecording(`\uFEFF${lines.join('\n')}`), expected);
	assert.deepEqual(parseCast(`\uFEFF${lines.join('\r\n')}`), expected);
});

test('negative intervals count as none', () => {
	assert.deepEqual(parseCast(`${HEADER}\n[0.5, "o", "a"]\n[-3, "o", "b"]\n[-1, "m", ""]\n[0.25, "o", "c"]`)?.events, [[0.5, 'a'], [0, 'b'], [0.25, 'c']]);
});

test('output that is not text is an error; other events with any data are skipped', () => {
	assert.throws(() => parseCast(`${HEADER}\n[0.5, "o", 42]`), /Line 2 of the asciicast is output that isn't text/);
	assert.throws(() => parseCast(`${HEADER}\n[0.5, "o", null]\n[0.5, "o", "a"]`), /Line 2 of the asciicast is output that isn't text/);
	assert.deepEqual(parseCast(`${HEADER}\n[0.5, "x", 0]\n[0.5, "o", "a"]`)?.events, [[1, 'a']]);
});

test('blank lines and comments before the header', () => {
	const recording = parseRecording(`\n# recorded by hand\n\n${HEADER}\n[0.5, "o", "a"]\n`);
	assert.equal(recording.format, 'asciicast');
	assert.deepEqual(recording.events, [[0.5, 'a']]);
	// The line numbers in errors are the file's.
	assert.throws(() => parseCast(`# a\n${HEADER}\nnope\n[0.5, "o", "a"]`), /Line 3 of the asciicast isn't JSON/);
});

test('a pretty-printed asciicast of version 1 says how to convert it', () => {
	const v1 = JSON.stringify({ version: 1, width: 80, height: 24, duration: 1, stdout: [[0.5, 'hello']] }, null, 2);
	assert.throws(() => parseRecording(v1), /version 1.*asciinema convert/);
	assert.throws(() => parseRecording(`\uFEFF${v1.replaceAll('\n', '\r\n')}`), /version 1.*asciinema convert/);
	// JSON over many lines that isn't an asciicast is output.
	assert.equal(parseRecording(JSON.stringify({ hello: 'world' }, null, 2)).format, 'output');
	assert.equal(parseRecording('{\n  not json').format, 'output');
});

test('a file that is not an asciicast keeps the last part of its output, as an embed does', () => {
	const text = `${'x'.repeat(OUTPUT_KEEP)}\r\n${'y'.repeat(100)}`;
	const { events } = parseRecording(text);
	assert.equal(events.length, 1);
	assert.equal(events[0][1], keepLast(text, OUTPUT_KEEP));
	assert.ok(events[0][1].length <= OUTPUT_KEEP && events[0][1].startsWith('\r\n'));
});

test('readLimited reads a body as UTF-8, and stops past its limit', async () => {
	const body = (/** @type {Uint8Array[]} */ ...chunks) => new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
	const bytes = new TextEncoder().encode('héllo 😀');
	// A character split between chunks.
	assert.equal(await readLimited(body(bytes.slice(0, 2), bytes.slice(2, 9), bytes.slice(9)), 100), 'héllo 😀');
	assert.equal(await readLimited(body(bytes), bytes.byteLength), 'héllo 😀');
	assert.equal(await readLimited(body(bytes), bytes.byteLength - 1), undefined);
	assert.equal(await readLimited(null, 10), '');
	// It cancels the rest: a body that never ends still returns.
	let cancelled = false;
	const endless = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
	assert.equal(await readLimited(endless, 10_000), undefined);
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(cancelled);
});
