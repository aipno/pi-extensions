/**
 * Minimal ZIP reader — self-implemented container parsing with node:zlib for
 * deflate. Supports stored and deflated entries, central-directory traversal,
 * and text content extraction for the read tool.
 */

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
	/** Entry path as stored in the archive. */
	name: string;
	/** Uncompressed size. */
	size: number;
	/** True when the entry is a directory. */
	isDirectory: boolean;
	/** Raw method: 0 = stored, 8 = deflate. */
	method: number;
	/** Local header offset (used for content reads). */
	localHeaderOffset: number;
	/** CRC-32 (unused for reading, kept for diagnostics). */
	crc: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function readU16(buf: Buffer, offset: number): number {
	return buf.readUInt16LE(offset);
}

function readU32(buf: Buffer, offset: number): number {
	return buf.readUInt32LE(offset);
}

/**
 * Parse a zip buffer, returning the central-directory entries.
 * Throws on malformed archives.
 */
export function parseZip(buffer: Buffer): ZipEntry[] {
	if (buffer.length < 22) throw new Error("Not a valid zip file");
	// Locate the End of Central Directory record (scan backwards for the
	// signature within the last 64KB + 22 bytes).
	const maxScan = Math.min(buffer.length, 22 + 65536);
	const start = buffer.length - maxScan;
	let eocdOffset = -1;
	for (let i = buffer.length - 22; i >= start; i--) {
		if (readU32(buffer, i) === EOCD_SIGNATURE) {
			eocdOffset = i;
			break;
		}
	}
	if (eocdOffset === -1) throw new Error("Not a valid zip file (no end-of-central-directory record)");

	const entryCount = readU16(buffer, eocdOffset + 10);
	const centralOffset = readU32(buffer, eocdOffset + 16);
	if (centralOffset >= buffer.length) throw new Error("Corrupt zip file (central directory offset out of range)");

	const entries: ZipEntry[] = [];
	let offset = centralOffset;
	for (let i = 0; i < entryCount; i++) {
		if (offset + 46 > buffer.length || readU32(buffer, offset) !== CENTRAL_SIGNATURE) {
			throw new Error("Corrupt zip file (bad central directory entry)");
		}
		const method = readU16(buffer, offset + 10);
		const crc = readU32(buffer, offset + 16);
		const compressedSize = readU32(buffer, offset + 20);
		const size = readU32(buffer, offset + 24);
		const nameLength = readU16(buffer, offset + 28);
		const extraLength = readU16(buffer, offset + 30);
		const commentLength = readU16(buffer, offset + 32);
		const localHeaderOffset = readU32(buffer, offset + 42);
		if (offset + 46 + nameLength > buffer.length) throw new Error("Corrupt zip file (entry name out of range)");
		const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
		entries.push({
			name,
			size,
			isDirectory: name.endsWith("/"),
			method,
			localHeaderOffset,
			crc,
		});
		void compressedSize;
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/**
 * Extract an entry's uncompressed content.
 * `entry` must come from the same buffer (local header offsets are stored).
 */
export function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
	const offset = entry.localHeaderOffset;
	if (offset + 30 > buffer.length || readU32(buffer, offset) !== LOCAL_SIGNATURE) {
		throw new Error("Corrupt zip file (bad local header)");
	}
	const nameLength = readU16(buffer, offset + 26);
	const extraLength = readU16(buffer, offset + 28);
	const dataStart = offset + 30 + nameLength + extraLength;
	if (entry.method === 0) {
		return buffer.subarray(dataStart, dataStart + entry.size);
	}
	if (entry.method === 8) {
		return inflateRawSync(buffer.subarray(dataStart));
	}
	throw new Error(`Unsupported zip compression method: ${entry.method}`);
}