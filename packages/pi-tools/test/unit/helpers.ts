/**
 * Test helpers: temp fixtures, minimal zip/tar writers (self-implemented,
 * mirroring the readers' formats).
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

/** Create a temp dir with the given files ({ relPath: content }). */
export async function makeFixture(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-tools-test-"));
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(join(abs, ".."), { recursive: true });
		await writeFile(abs, content);
	}
	return root;
}

/** Write a buffer fixture file. */
export async function writeBuffer(root: string, rel: string, buf: Buffer): Promise<string> {
	const abs = join(root, rel);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, buf);
	return abs;
}

interface ZipInputEntry {
	name: string;
	data: Buffer | string;
}

/** Build a minimal zip archive (stored or deflated entries). */
export function makeZip(entries: ZipInputEntry[], method: 0 | 8 = 8): Buffer {
	const chunks: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
		const compressed = method === 8 ? deflateRawSync(data) : data;
		const nameLen = nameBuf.length;
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // flags (UTF-8)
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameLen, 26);
		local.writeUInt16LE(0, 28);

		chunks.push(local, nameBuf, compressed);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0x0800, 8);
		centralHeader.writeUInt16LE(method, 10);
		centralHeader.writeUInt32LE(crc, 16);
		centralHeader.writeUInt32LE(compressed.length, 20);
		centralHeader.writeUInt32LE(data.length, 24);
		centralHeader.writeUInt16LE(nameLen, 28);
		centralHeader.writeUInt32LE(offset, 42);
		central.push(centralHeader, nameBuf);

		offset += 30 + nameLen + compressed.length;
	}
	const centralSize = central.reduce((n, b) => n + b.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...chunks, ...central, eocd]);
}

/** Build a minimal tar archive (ustar, works with the reader). */
export function makeTar(entries: Array<{ name: string; data?: string | Buffer; isDir?: boolean }>): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		const header = Buffer.alloc(512);
		nameBuf.copy(header, 0, 0, Math.min(nameBuf.length, 100));
		const data = entry.isDir ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
		header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
		header.write("0000644\0", 100, "ascii");
		header.write("0000000\0", 108, "ascii");
		header.write("0000000\0", 116, "ascii");
		header.write(entry.isDir ? "5" : "0", 156, "ascii");
		header.write("ustar\0", 257, "ascii");
		header.write("00", 263, "ascii");
		blocks.push(header);
		if (data.length > 0) {
			blocks.push(data);
			const pad = 512 - (data.length % 512);
			if (pad !== 512) blocks.push(Buffer.alloc(pad));
		}
	}
	blocks.push(Buffer.alloc(1024)); // end-of-archive
	return Buffer.concat(blocks);
}

let crcTable: Uint32Array | undefined;
export function crc32(buf: Buffer): number {
	crcTable ??= (() => {
		const table = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			table[n] = c >>> 0;
		}
		return table;
	})();
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		crc = crcTable[(crc ^ buf[i]) & 0xff]! ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}