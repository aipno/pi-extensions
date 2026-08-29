/**
 * 工具输入/输出全文预览 overlay（由 fullscreen 鼠标点击 "show more" 触发）。
 *
 * 从参考项目 pi-cc-extensions 的 /context 模块中抽出的自包含部分：
 * 仅保留 showTextPreview / hasActiveTextPreview，与 /context 命令本身解耦。
 */
import { type ExtensionCommandContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { mouseBaseButton, parseSgrMousePacket } from "../utils/sgr-mouse.ts";
import { padLine } from "../utils/format.ts";

export function normalizePreviewText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export type DialogBounds = { left: number; top: number; width: number };

/** 1-based terminal hitbox of the [esc] close button on the dialog title row (row 2 of the box). */
export function escCloseHitbox(bounds: DialogBounds): {
	row: number;
	startCol: number;
	endCol: number;
} {
	return {
		row: bounds.top + 2,
		startCol: bounds.left + bounds.width - 5,
		endCol: bounds.left + bounds.width - 1,
	};
}

let activeContextOverlays = 0;

/** fullscreen 输入包装用于把鼠标事件继续传给当前 context 主弹框或文本预览 overlay。 */
export function pushActiveOverlay(): void {
	activeContextOverlays++;
}

/** 与 pushActiveOverlay 配对；弹框/预览关闭时调用。 */
export function popActiveOverlay(): void {
	activeContextOverlays--;
}

export function hasActiveTextPreview(): boolean {
	return activeContextOverlays > 0;
}

/** 官方 fullscreen 打开 overlay 时会退回 1002；重新启用 1003 才能收到无按键 hover。 */
export function ensureFullscreenMouseMotion(tui: any): void {
	if (tui.mode === "fullscreen") tui.terminal?.write?.("\x1b[?1003h\x1b[?1006h");
}

export async function showTextPreview(
	ctx: Pick<ExtensionCommandContext, "ui">,
	title: string,
	rawContent: string,
): Promise<void> {
	const content = normalizePreviewText(rawContent);
	pushActiveOverlay();
	try {
		await ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				ensureFullscreenMouseMotion(tui);
				let scrollOffset = 0;
				let pageSize = 1;
				let totalLines = 1;
				let escHovered = false;
				let escHitbox: { row: number; startCol: number; endCol: number } | undefined;
				let scrollbarHitbox:
					| {
							col: number;
							startRow: number;
							endRow: number;
							thumbStart: number;
							thumbSize: number;
							maxOffset: number;
					  }
					| undefined;
				let scrollbarDragOffset: number | null = null;
				const markdownView = new Markdown(content, 0, 0, getMarkdownTheme());

				const scrollTo = (nextOffset: number): void => {
					const next = Math.max(0, Math.min(nextOffset, Math.max(0, totalLines - pageSize)));
					if (next === scrollOffset) return;
					scrollOffset = next;
					tui.requestRender();
				};

				const setEscHovered = (hovered: boolean): void => {
					if (hovered === escHovered) return;
					escHovered = hovered;
					tui.requestRender();
				};

				const dragScrollbarTo = (mouseRow: number): void => {
					if (!scrollbarHitbox || scrollbarDragOffset === null) return;
					const trackSize = scrollbarHitbox.endRow - scrollbarHitbox.startRow + 1;
					const maxThumbStart = Math.max(0, trackSize - scrollbarHitbox.thumbSize);
					const thumbStart = Math.max(
						0,
						Math.min(mouseRow - scrollbarHitbox.startRow - scrollbarDragOffset, maxThumbStart),
					);
					const nextOffset =
						maxThumbStart > 0
							? Math.round((thumbStart / maxThumbStart) * scrollbarHitbox.maxOffset)
							: 0;
					scrollTo(nextOffset);
				};

				return {
					invalidate() {
						markdownView.invalidate();
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(undefined);
							return;
						}
						if (matchesKey(data, Key.up)) scrollTo(scrollOffset - 1);
						else if (matchesKey(data, Key.down)) scrollTo(scrollOffset + 1);
						else if (matchesKey(data, "pageUp")) scrollTo(scrollOffset - pageSize);
						else if (matchesKey(data, "pageDown")) scrollTo(scrollOffset + pageSize);
						else if (matchesKey(data, Key.home)) scrollTo(0);
						else if (matchesKey(data, Key.end)) scrollTo(totalLines - pageSize);
						else {
							const mouse = parseSgrMousePacket(data);
							if (!mouse) return;
							if (mouse.final === "m") {
								scrollbarDragOffset = null;
								return;
							}
							const overEsc = Boolean(
								escHitbox &&
									mouse.row === escHitbox.row &&
									mouse.col >= escHitbox.startCol &&
									mouse.col <= escHitbox.endCol,
							);
							setEscHovered(overEsc);
							const button = mouseBaseButton(mouse.code);
							const motion = (mouse.code & 32) !== 0;
							if (button === 0 && !motion) {
								if (overEsc) {
									done(undefined);
									return;
								}
								if (
									scrollbarHitbox &&
									mouse.col === scrollbarHitbox.col &&
									mouse.row >= scrollbarHitbox.startRow &&
									mouse.row <= scrollbarHitbox.endRow
								) {
									const trackRow = mouse.row - scrollbarHitbox.startRow;
									const inThumb =
										trackRow >= scrollbarHitbox.thumbStart &&
										trackRow < scrollbarHitbox.thumbStart + scrollbarHitbox.thumbSize;
									scrollbarDragOffset = inThumb
										? trackRow - scrollbarHitbox.thumbStart
										: Math.floor(scrollbarHitbox.thumbSize / 2);
									dragScrollbarTo(mouse.row);
									return;
								}
							}
							if (motion && scrollbarDragOffset !== null) {
								dragScrollbarTo(mouse.row);
								return;
							}
							if (button === 64) scrollTo(scrollOffset - 3);
							else if (button === 65) scrollTo(scrollOffset + 3);
						}
					},
					render(width: number) {
						const inner = Math.max(1, width - 2);
						const escWidth = visibleWidth("[esc]");
						const bodyInner = Math.max(1, inner - 1);
						const bodyWidth = Math.max(1, bodyInner - 1);
						const terminalHeight = Math.max(1, tui.terminal.rows);
						const availableHeight = Math.max(1, terminalHeight - 4);
						const viewportHeight = Math.min(
							30,
							Math.max(1, Math.floor(terminalHeight * 0.8)),
							availableHeight,
						);
						pageSize = Math.max(1, viewportHeight - 6);
						const wrapped = markdownView.render(bodyWidth);
						totalLines = wrapped.length;
						scrollOffset = Math.min(scrollOffset, Math.max(0, totalLines - pageSize));
						// Centered overlay with margin 2: mirror TUI resolveOverlayLayout for anchor "center".
						const overlayTop = 2 + Math.floor((availableHeight - viewportHeight) / 2);
						const overlayLeft = Math.floor((Math.max(1, tui.terminal.columns) - width) / 2);
						escHitbox = escCloseHitbox({ left: overlayLeft, top: overlayTop, width });
						const visible = wrapped.slice(scrollOffset, scrollOffset + pageSize);
						const border = (text: string) => theme.fg("border", text);
						const scrollable = totalLines > pageSize;
						const thumbSize = scrollable
							? Math.max(1, Math.floor((pageSize * pageSize) / totalLines))
							: 0;
						const maxScrollOffset = Math.max(0, totalLines - pageSize);
						const thumbStart =
							scrollable && maxScrollOffset > 0
								? Math.round((scrollOffset / maxScrollOffset) * (pageSize - thumbSize))
								: 0;
						scrollbarHitbox = scrollable
							? {
									col: overlayLeft + width - 1,
									startRow: overlayTop + 4,
									endRow: overlayTop + 3 + pageSize,
									thumbStart,
									thumbSize,
									maxOffset: maxScrollOffset,
								}
							: undefined;
						const scrollbar = (row: number): string => {
							if (!scrollable) return " ";
							const inThumb = row >= thumbStart && row < thumbStart + thumbSize;
							return theme.fg(inThumb ? "accent" : "borderMuted", inThumb ? "█" : "│");
						};
						const bodyRows = Array.from({ length: pageSize }, (_, row) => {
							const line = visible[row] ?? "";
							return `${border("│")}${padLine(` ${line}`, bodyInner)}${scrollbar(row)}${border("│")}`;
						});
						const start = totalLines === 0 ? 0 : scrollOffset + 1;
						const end = Math.min(totalLines, scrollOffset + pageSize);
						const status = `${start}-${end} / ${totalLines} lines · ↑↓ PgUp/PgDn Home/End · [esc] close`;

						return [
							border(`╭${"─".repeat(inner)}╮`),
							`${border("│")}${padLine(` ${theme.bold(theme.fg("accent", title))}`, inner - escWidth)}${theme.fg(escHovered ? "text" : "muted", "[esc]")}${border("│")}`,
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							...bodyRows,
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							`${border("│")}${padLine(theme.fg("dim", ` ${status}`), inner)}${border("│")}`,
							border(`╰${"─".repeat(inner)}╯`),
						];
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "85%",
					minWidth: 50,
					maxHeight: "80%",
					margin: 2,
				},
			},
		);
	} finally {
		popActiveOverlay();
	}
}

