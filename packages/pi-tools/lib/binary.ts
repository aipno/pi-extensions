/**
 * Binary detection for the read tool and the search engine.
 *
 * Mirrors the heuristic used by pi/omp built-ins: sniff a prefix of the file
 * for NUL bytes. UTF-16 text legitimately contains NULs, so also accept
 * UTF-16LE/BE BOMs as text.
 */

/** Number of leading bytes sniffed for NUL detection. */
export const BINARY_SNIFF_BYTES = 8192;

/** UTF-16 BOMs are treated as text even though half their bytes are NUL. */
const UTF16_BOMS = [0xfffe, 0xfeff];

/**
 * True when `buf` looks like binary data (NUL byte within the sniff range,
 * excluding UTF-16 BOM-flagged content).
 */
export function isProbablyBinary(buf: Uint8Array): boolean {
	const sniff = buf.subarray(0, BINARY_SNIFF_BYTES);
	if (sniff.length >= 2) {
		const first = (sniff[0] << 8) | sniff[1];
		if (UTF16_BOMS.includes(first)) return false;
	}
	for (let i = 0; i < sniff.length; i++) {
		if (sniff[i] === 0) return true;
	}
	return false;
}