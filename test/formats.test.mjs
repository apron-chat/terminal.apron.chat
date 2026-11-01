import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IDLE_LIMIT, GOLDEN_SEPARATOR, parseCast, parseRecording, Recorder, replayDelays, writeCast, writeGolden } from '../src/formats.js';
import { OUTPUT_KEEP } from '../src/screen.js';

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
	assert.throws(() => parseCast('{"version": 3, "term": {"cols": 80, "rows": 24}}\nnot json'), /Line 2 of the asciicast isn't JSON/);
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

test('writeGolden writes a frame as VHS does: each row trimmed, then 80 ─', () => {
	const rows = ['$ make  ', 'ok', '', ''];
	assert.equal(writeGolden(rows), `$ make\nok\n\n\n${GOLDEN_SEPARATOR}\n`);
	assert.equal(GOLDEN_SEPARATOR, '─'.repeat(80));
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

test('replay pauses are capped at the idle limit', () => {
	assert.deepEqual(replayDelays({ events: [[0.1, 'a'], [30, 'b']] }), [100, DEFAULT_IDLE_LIMIT * 1000]);
	assert.deepEqual(replayDelays({ events: [[0.1, 'a'], [30, 'b']], idleLimit: 0.5 }), [100, 500]);
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
