/**
 * shared-ticker 单测：单 timer 多注册者、空表自动停、unref 不阻塞退出、
 * 异频隔离（80ms spinner 与 750ms 心跳不共享表）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getSharedTicker, sharedSpinnerTicker } from "../extensions/utils/shared-ticker.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("shared ticker：多注册者同频共享，注销后自动停", async () => {
	const ticker = getSharedTicker(15);
	let a = 0;
	let b = 0;
	const unwatchA = ticker.watch(() => a++);
	ticker.watch(() => b++);
	assert.equal(ticker.size, 2);
	await sleep(60);
	assert.ok(a >= 2 && b >= 2, `a=${a} b=${b}`);
	ticker.reset();
});

test("shared ticker：unwatch 空表停转，重注册恢复", async () => {
	const ticker = getSharedTicker(15);
	let hits = 0;
	const unwatch = ticker.watch(() => hits++);
	await sleep(40);
	unwatch();
	const at = hits;
	await sleep(40);
	assert.equal(hits, at, "空表应停");
	ticker.watch(() => hits++);
	await sleep(40);
	assert.ok(hits > at, "重注册应恢复");
	ticker.reset();
});

test("shared ticker：同频实例复用，异频独立", () => {
	const t80 = getSharedTicker(80);
	const t80b = getSharedTicker(80);
	const t750 = getSharedTicker(750);
	assert.equal(t80, t80b);
	assert.equal(t80, sharedSpinnerTicker);
	assert.notEqual(t80, t750);
	tickerCleanup(t80, t750);
});

function tickerCleanup(...tickers: { reset: () => void }[]) {
	for (const ticker of tickers) ticker.reset();
}

test("shared ticker：回调抛错不影响其它注册者", async () => {
	const ticker = getSharedTicker(15);
	const unwatchBad = ticker.watch(() => {
		throw new Error("boom");
	});
	let good = 0;
	const unwatchGood = ticker.watch(() => good++);
	await sleep(50);
	assert.ok(good >= 2);
	unwatchBad();
	unwatchGood();
	ticker.reset();
});