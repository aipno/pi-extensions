/**
 * Minimal tar reader — ustar format with GNU long-name extension and gzip
 * wrapping, self-implemented on node:zlib.
 */

import { gunzipSync } from "node:zlib";

export interface TarEntry {
	name: string;
	size: number;
	isDirectory: boolean;
	/** Data offset within the (possibly decompressed) tar buffer. */
	offset: number;
}

const BLOCK = 512;

function readOctal(buf: Buffer, offset: number, length: number): number {
	const raw = buf.toString("utf8", offset, offset + length).trim();
	if (raw === "") return 0;
	// GNU base-256 encoding (high bit set) for very large values.
	if (raw.charCodeAt(0) & 0x80) {
		let value = 0;
		for (let i = 0; i < length; i++) {
			const byte = buf[offset + i];
			if (byte === undefined) break;
			value = value * 256 + (i === 0 ? byte & 0x7f : byte);
		}
		return value;
	}
	// Strip NUL/space padding.
	const cleaned = raw.replace(/\0/g, "").trim();
	if (cleaned === "") return 0;
	return parseInt(cleaned, 8);
}

/**
 * Parse a tar buffer (already decompressed for .tar.gz), returning entries
 * with their data offsets.
 */
export function parseTar(buffer: Buffer): TarEntry[] {
	const entries: TarEntry[] = [];
	let offset = 0;
	while (offset + BLOCK <= buffer.length) {
		const name = buffer.toString("utf8", offset, offset + 100).replace(/\0.*$/, "");
		if (name === "") break; // end of archive (zero block)
		const mode = buffer.toString("utf8", offset + 100, offset + 108);
		const size = readOctal(buffer, offset + 124, 12);
		const typeFlag = String.fromCharCode(buffer[offset + 156] ?? 0x30);
		const magic = buffer.toString("utf8", offset + 257, offset + 263);

		let entryName = name;
		let entrySize = size;
		let entryOffset = offset + BLOCK;

		if (magic.startsWith("ustar")) {
			// ustar prefix field (up to 155 chars) concatenated with name.
			const prefix = buffer.toString("utf8", offset + 345, offset + 500).replace(/\0.*$/, "");
			if (prefix !== "") entryName = `${prefix}/${name}`;
		}

		if (typeFlag === "L") {
			// GNU long name: the data block contains the real name.
			const longName = buffer.toString("utf8", entryOffset, entryOffset + size).replace(/\0.*$/, "");
			entryOffset += Math.ceil(size / BLOCK) * BLOCK;
			const next = readNextHeader(buffer, entryOffset);
			entryName = longName;
			entrySize = next.size;
			entryOffset = next.offset;
			entries.push({
				name: entryName,
				size: entrySize,
				isDirectory: next.typeFlag === "5",
				offset: entryOffset,
			});
			entryOffset += Math.ceil(entrySize / BLOCK) * BLOCK;
			offset = entryOffset;
			continue;
		}
		if (typeFlag === "K") {
			// GNU long link target: skip its data block.
			entryOffset += Math.ceil(size / BLOCK) * BLOCK;
			offset = entryOffset;
			continue;
		}
		if (typeFlag === "5") {
			entries.push({ name: entryName, size: 0, isDirectory: true, offset: entryOffset });
			offset = entryOffset;
			continue;
		}
		if (typeFlag === "0" || typeFlag === "\0" || typeFlag === "7" || typeFlag === " ") {
			entries.push({ name: entryName, size: entrySize, isDirectory: false, offset: entryOffset });
			entryOffset += Math.ceil(entrySize / BLOCK) * BLOCK;
			offset = entryOffset;
			continue;
		}
		// Other types (symlinks, devices, ...): skip data.
		offset = entryOffset + Math.ceil(entrySize / BLOCK) * BLOCK;
		void mode;
	}
	return entries;
}

function readNextHeader(buffer: Buffer, offset: number): { size: number; typeFlag: string; offset: number } {
	if (offset + BLOCK > buffer.length) return { size: 0, typeFlag: "0", offset };
	const size = readOctal(buffer, offset + 124, 12);
	const typeFlag = String.fromCharCode(buffer[offset + 156] ?? 0x30);
	return { size, typeFlag, offset: offset + BLOCK };
}

/**
 * Read a tar file from disk bytes: transparently gunzips when the archive
 * appears to be gzip-wrapped.
 */
export function loadTar(buffer: Buffer, isGzip: boolean): { entries: TarEntry[]; data: Buffer } {
	const data = isGzip ? gunzipSync(buffer) : buffer;
	return { entries: parseTar(data), data };
}

/** Extract an entry's bytes from the (decompressed) tar data. */
export function readTarEntry(data: Buffer, entry: TarEntry): Buffer {
	return data.subarray(entry.offset, entry.offset + entry.size);
}