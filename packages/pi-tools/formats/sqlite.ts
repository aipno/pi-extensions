/**
 * SQLite preview via node:sqlite (Node 22.5+). The read tool uses this for
 * `.db` / `.sqlite` / `.sqlite3` files: lists tables and their row counts,
 * then previews rows when requested.
 */

import type { DatabaseSync } from "node:sqlite";

export interface SqliteTablePreview {
	name: string;
	rowCount: number;
	/** Column names of the preview. */
	columns: string[];
	/** Up to `limit` rows, each a row-major array of cell strings. */
	rows: string[][];
}

export interface SqlitePreviewOptions {
	/** Maximum rows previewed per table. Default: 20. */
	limit?: number;
	/** When true, only table names + counts are listed. */
	metadataOnly?: boolean;
}

let sqliteModule: typeof import("node:sqlite") | undefined;
let sqliteUnavailable: string | undefined;

async function loadSqlite(): Promise<typeof import("node:sqlite") | undefined> {
	if (sqliteModule) return sqliteModule;
	if (sqliteUnavailable) return undefined;
	try {
		sqliteModule = await import("node:sqlite");
		return sqliteModule;
	} catch {
		sqliteUnavailable = "node:sqlite is not available in this Node runtime (required: Node >= 22.5)";
		return undefined;
	}
}

function cellToString(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Uint8Array) {
		// Show small blobs as hex, large ones truncated.
		const hex = Buffer.from(value).toString("hex");
		return hex.length > 64 ? `<blob ${value.length} bytes>` : `x'${hex}'`;
	}
	return String(value);
}

/**
 * Open a read-only handle to the database and preview its tables.
 * Returns null when node:sqlite is unavailable.
 */
export async function previewSqlite(
	filePath: string,
	options: SqlitePreviewOptions = {},
): Promise<{ tables: SqliteTablePreview[]; error?: string }> {
	const mod = await loadSqlite();
	if (!mod) {
		return { tables: [], error: sqliteUnavailable ?? "node:sqlite unavailable" };
	}
	const limit = options.limit ?? 20;
	let db: DatabaseSync;
	try {
		db = new mod.DatabaseSync(filePath, { readOnly: true });
	} catch (err) {
		throw new Error(`Cannot open SQLite database: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		const tables: SqliteTablePreview[] = [];
		const names = db
			.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
			.all() as Array<{ name: string }>;
		for (const { name } of names) {
			let rowCount = 0;
			try {
				const count = db.prepare(`SELECT COUNT(*) AS c FROM "${name.replaceAll('"', '""')}"`).get() as { c: number };
				rowCount = Number(count.c);
			} catch {
				rowCount = -1; // views or odd tables that cannot be counted
			}
			if (options.metadataOnly) {
				tables.push({ name, rowCount, columns: [], rows: [] });
				continue;
			}
			try {
				const stmt = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" LIMIT ${Math.max(0, limit)}`);
				const columns = stmt.columns().map((c) => c.name);
				const rows = (stmt.all() as unknown[]).map((row) => {
					const record = row as Record<string, unknown>;
					return columns.map((col) => cellToString(record[col]));
				});
				tables.push({ name, rowCount, columns, rows });
			} catch {
				tables.push({ name, rowCount, columns: [], rows: [] });
			}
		}
		return { tables };
	} finally {
		try {
			db.close();
		} catch {
			// already closed
		}
	}
}

/** Render sqlite preview output for the read tool. */
export function formatSqlitePreview(tables: SqliteTablePreview[], currentOffset: number, currentLimit: number): string {
	if (tables.length === 0) return "(no tables)";
	const out: string[] = [];
	for (const table of tables) {
		out.push(`Table: ${table.name} (${table.rowCount >= 0 ? table.rowCount : "?"} rows)`);
		if (table.columns.length === 0) continue;
		out.push(`  ${table.columns.join(" | ")}`);
		let row = 0;
		if (currentOffset > 0) {
			const skipped = Math.min(table.rows.length, currentOffset);
			out.push(`  ... ${skipped} row(s) skipped`);
			row = skipped;
		}
		const displayLimit = currentLimit > 0 ? currentLimit : table.rows.length;
		for (let i = row; i < Math.min(table.rows.length, row + displayLimit); i++) {
			out.push(`  ${table.rows[i]!.join(" | ")}`);
		}
		if (table.rows.length > row + displayLimit) {
			out.push(`  ... ${table.rows.length - (row + displayLimit)} more row(s)`);
		}
	}
	return out.join("\n");
}