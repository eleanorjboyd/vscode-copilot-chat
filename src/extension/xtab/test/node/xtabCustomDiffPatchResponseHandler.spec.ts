/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { NoNextEditReason, StreamedEdit } from '../../../../platform/inlineEdits/common/statelessNextEditProvider';
import { AsyncIterUtils } from '../../../../util/common/asyncIterableUtils';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { XtabCustomDiffPatchResponseHandler } from '../../node/xtabCustomDiffPatchResponseHandler';

async function consumeHandleResponse(
	...args: Parameters<typeof XtabCustomDiffPatchResponseHandler.handleResponse>
): Promise<{ edits: StreamedEdit[]; returnValue: NoNextEditReason }> {
	const gen = XtabCustomDiffPatchResponseHandler.handleResponse(...args);
	const edits: StreamedEdit[] = [];
	for (; ;) {
		const result = await gen.next();
		if (result.done) {
			return { edits, returnValue: result.value };
		}
		edits.push(result.value);
	}
}

describe('XtabCustomDiffPatchResponseHandler', () => {

	async function collectPatches(patchText: string): Promise<string> {
		const linesStream = AsyncIterUtils.fromArray(patchText.split('\n'));
		const patches = await AsyncIterUtils.toArray(XtabCustomDiffPatchResponseHandler.extractEdits(linesStream));
		return patches.map(p => p.toString()).join('\n');
	}

	it('should parse a simple patch correctly', async () => {
		const patchText = `file1.txt:10
-Old line 1
-Old line 2
+New line 1
+New line 2`;
		const patches = await collectPatches(patchText);
		expect(patches).toEqual(patchText);
	});

	it('should parse a simple patch correctly despite trailing newline', async () => {
		const patchText = `file1.txt:10
-Old line 1
-Old line 2
+New line 1
+New line 2
`;
		const patches = await collectPatches(patchText);
		expect(patches).toEqual(patchText.trim());
	});

	it('should parse a simple patch correctly', async () => {
		const patchText = `/absolutePath/to/my_file.ts:1
-Old line 1
+New line 1
+New line 2
relative/path/to/another_file.js:42
-Removed line
+Added line`;
		const patches = await collectPatches(patchText);
		expect(patches).toEqual(patchText);
	});

	it('discard a patch if no valid header', async () => {
		const patchText = `myFile.ts:
+New line 1
+New line 2
another_file.js:32
-Removed line
+Added line`;
		const patches = await collectPatches(patchText);
		expect(patches).toMatchInlineSnapshot(`
			"another_file.js:32
			-Removed line
			+Added line"
		`);
	});

	it('discard a patch if no valid header - 2', async () => {
		const patchText = `myFile.ts:42
+New line 1
+New line 2
another_file.js:
-Removed line
+Added line`;
		const patches = await collectPatches(patchText);
		expect(patches).toMatchInlineSnapshot(`
			"myFile.ts:42
			+New line 1
			+New line 2"
		`);
	});

	it('discard a patch has no removed lines', async () => {
		const patchText = `myFile.ts:42
+New line 1
+New line 2`;
		const patches = await collectPatches(patchText);
		expect(patches).toMatchInlineSnapshot(`
			"myFile.ts:42
			+New line 1
			+New line 2"
		`);
	});

	it('discard a patch has no new lines', async () => {
		const patchText = `myFile.ts:42
-Old line 1
-Old line 2`;
		const patches = await collectPatches(patchText);
		expect(patches).toMatchInlineSnapshot(`
			"myFile.ts:42
			-Old line 1
			-Old line 2"
		`);
	});

	it('stops yielding edits when getFetchFailure returns a failure', async () => {
		const patchText = `file.ts:0
-old
+new
file.ts:5
-another old
+another new`;
		const linesStream = AsyncIterUtils.fromArray(patchText.split('\n'));
		const docId = DocumentId.create('file:///file.ts');
		const documentBeforeEdits = new StringText('old\n');

		let yieldCount = 0;
		const cancellationReason = new NoNextEditReason.GotCancelled('afterFetchCall');

		const { edits, returnValue } = await consumeHandleResponse(
			linesStream,
			documentBeforeEdits,
			docId,
			undefined,
			undefined,
			undefined,
			() => {
				// Signal failure after the first edit has been yielded
				if (yieldCount++ > 0) {
					return cancellationReason;
				}
				return undefined;
			},
		);

		expect(edits).toHaveLength(1);
		expect(returnValue).toBe(cancellationReason);
	});

	it('does not yield truncated patch when fetch is cancelled mid-stream', async () => {
		// Full response would be:
		//   file.ts:0 / -old / +new / file.ts:5 / -another old / +another new / +one more new
		// But the fetch is cancelled right before "+one more new" is emitted,
		// so the stream only delivers lines up to "+another new".
		// The second patch is incomplete and must not be yielded.
		const truncatedPatchText = `file.ts:0
-old
+new
file.ts:5
-another old
+another new`;
		// "+one more new" is missing — fetch was cancelled before it arrived
		const linesStream = AsyncIterUtils.fromArray(truncatedPatchText.split('\n'));
		const docId = DocumentId.create('file:///file.ts');
		const documentBeforeEdits = new StringText('old\n');

		let checkCount = 0;
		const cancellationReason = new NoNextEditReason.GotCancelled('afterFetchCall');

		const { edits, returnValue } = await consumeHandleResponse(
			linesStream,
			documentBeforeEdits,
			docId,
			undefined,
			undefined,
			undefined,
			() => {
				// Fetch was still running (not yet cancelled) when the first edit was checked,
				// but was cancelled before the second (incomplete) edit is about to be yielded.
				return checkCount++ > 0 ? cancellationReason : undefined;
			},
		);

		// The first (complete) edit is yielded; the second (truncated) edit is not
		expect(edits).toHaveLength(1);
		expect(returnValue).toBe(cancellationReason);
	});
});
