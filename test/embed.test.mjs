import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEIGHT, isFramed, OUTPUT, outputOf, READY } from '../src/embed.js';
import { OUTPUT_KEEP } from '../src/screen.js';

test('message types are namespaced', () => {
	assert.deepEqual([READY, HEIGHT, OUTPUT], ['apron-terminal:ready', 'apron-terminal:height', 'apron-terminal:output']);
});

test('only an output message carries output', () => {
	assert.equal(outputOf({ type: OUTPUT, output: '\x1b[32mok\x1b[0m\r\n' }), '\x1b[32mok\x1b[0m\r\n');
	assert.equal(outputOf({ type: OUTPUT, output: '' }), '');
	for (const data of [null, undefined, 'apron-terminal:output', 42, {}, { type: OUTPUT }, { type: OUTPUT, output: 42 }, { type: 'other', output: 'x' }]) {
		assert.equal(outputOf(data), undefined, JSON.stringify(data));
	}
});

test('a long output is cut to what the page shows', () => {
	const output = `${'x'.repeat(OUTPUT_KEEP)}\r\n${'y'.repeat(100)}`;
	const shown = outputOf({ type: OUTPUT, output });
	assert.ok(shown !== undefined && shown.length <= OUTPUT_KEEP);
	assert.ok(shown?.startsWith('\r\n'));
});

test('framed: when the top window is another', () => {
	const self = {};
	assert.equal(isFramed(/** @type {Window} */ (/** @type {unknown} */ ({ self, top: self }))), false);
	assert.equal(isFramed(/** @type {Window} */ (/** @type {unknown} */ ({ self, top: {} }))), true);
	const throwing = { self, get top() { throw new Error('blocked'); } };
	assert.equal(isFramed(/** @type {Window} */ (/** @type {unknown} */ (throwing))), true);
});
