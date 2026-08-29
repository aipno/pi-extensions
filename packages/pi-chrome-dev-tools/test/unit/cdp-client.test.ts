import { test } from "node:test";
import assert from "node:assert/strict";
import {
	setBrowserManagerOperationsForTests,
	syncManagedBrowserSettings,
} from "../../src/browser-manager.ts";
import {
	CdpClient,
	type CdpWebSocketConstructor,
	resolvePage,
	setActivePageId,
} from "../../src/cdp-client.ts";
import { state } from "../../src/runtime.ts";

class FakeWebSocket extends EventTarget {
	closeCalls = 0;
	readonly sent: string[] = [];
	readonly url: string | URL;

	constructor(url: string | URL) {
		super();
		this.url = url;
	}

	close(): void {
		this.closeCalls += 1;
	}

	fail(): void {
		this.dispatchEvent(new Event("error"));
	}

	message(payload: unknown): void {
		this.dispatchEvent(
			new MessageEvent("message", {
				data: typeof payload === "string" ? payload : JSON.stringify(payload),
			}),
		);
	}

	open(): void {
		this.dispatchEvent(new Event("open"));
	}

	respond(result: unknown = {}, error?: { code: number; message: string }): void {
		const request = JSON.parse(this.sent.at(-1) ?? "null") as { id?: unknown };
		assert.equal(typeof request.id, "number");
		this.message({ id: request.id, ...(error ? { error } : { result }) });
	}

	send(payload: string): void {
		this.sent.push(payload);
	}
}

function socketFactory() {
	const sockets: FakeWebSocket[] = [];
	class RecordingWebSocket extends FakeWebSocket {
		constructor(url: string | URL) {
			super(url);
			sockets.push(this);
		}
	}
	return {
		sockets,
		webSocketConstructor: RecordingWebSocket as unknown as CdpWebSocketConstructor,
	};
}

async function connectClient(timeoutMs = 100) {
	const transport = socketFactory();
	const connected = CdpClient.connect("ws://127.0.0.1/devtools/page/test", {
		timeoutMs,
		webSocketConstructor: transport.webSocketConstructor,
	});
	const socket = transport.sockets[0];
	assert.ok(socket);
	socket.open();
	return { client: await connected, socket };
}

test("reports connection errors and connection timeouts while closing the socket", async () => {
	const failedTransport = socketFactory();
	const failed = CdpClient.connect("ws://127.0.0.1/devtools/page/fail", {
		timeoutMs: 100,
		webSocketConstructor: failedTransport.webSocketConstructor,
	});
	const failedSocket = failedTransport.sockets[0];
	assert.ok(failedSocket);
	failedSocket.fail();
	await assert.rejects(failed, /Failed to connect/u);
	assert.equal(failedSocket.closeCalls, 1);

	const timeoutTransport = socketFactory();
	const timedOut = CdpClient.connect("ws://127.0.0.1/devtools/page/timeout", {
		timeoutMs: 5,
		webSocketConstructor: timeoutTransport.webSocketConstructor,
	});
	await assert.rejects(timedOut, /Timed out connecting/u);
	assert.equal(timeoutTransport.sockets[0]?.closeCalls, 1);
});

test("correlates command errors and keeps command cancellation operation-scoped", async () => {
	const { client, socket } = await connectClient();
	const failed = client.send("Page.enable", {}, { timeoutMs: 100 });
	socket.respond(undefined, { code: -32_601, message: "Method unavailable" });
	await assert.rejects(failed, /CDP error -32601: Method unavailable/u);

	const controller = new AbortController();
	const aborted = client.send(
		"Runtime.evaluate",
		{},
		{
			signal: controller.signal,
			timeoutMs: 100,
		},
	);
	controller.abort(new Error("cancel command"));
	await assert.rejects(aborted, /cancel command/u);

	const succeeded = client.send("Page.getFrameTree", {}, { timeoutMs: 100 });
	socket.respond({ frameTree: { frame: { id: "root", url: "about:blank" } } });
	assert.deepEqual(await succeeded, {
		frameTree: { frame: { id: "root", url: "about:blank" } },
	});
	client.close();
});

test("buffers an event that arrives before its command response", async () => {
	const { client, socket } = await connectClient();
	const enabled = client.send("Page.enable", {}, { timeoutMs: 100 });
	socket.message({
		method: "Runtime.executionContextCreated",
		params: { context: { id: 1, origin: "https://example.test" } },
	});
	socket.respond({});
	await enabled;

	const event = await client.waitForEvent(
		"Runtime.executionContextCreated",
		(value): value is { context: { id: unknown } } =>
			typeof value === "object" &&
			value !== null &&
			typeof (value as { context?: unknown }).context === "object",
		{ timeoutMs: 100 },
	);
	assert.equal(event.context.id, 1);

	const responseFirstEvent = client.waitForEvent(
		"Runtime.executionContextCreated",
		(value): value is { context: { id: unknown } } =>
			typeof value === "object" &&
			value !== null &&
			typeof (value as { context?: unknown }).context === "object",
		{ timeoutMs: 100 },
	);
	const responseFirstCommand = client.send("Page.enable", {}, { timeoutMs: 100 });
	socket.respond({});
	await responseFirstCommand;
	socket.message({
		method: "Runtime.executionContextCreated",
		params: { context: { id: 2, origin: "https://other.test" } },
	});
	assert.deepEqual((await responseFirstEvent).context, { id: 2, origin: "https://other.test" });
	client.close();
});

function endpointFixture(port: number) {
	return {
		endpoint: `http://127.0.0.1:${port}`,
		host: "127.0.0.1",
		port,
		hostConfigured: true,
		portConfigured: true,
		autoLaunchEnabled: false,
		endpointSource: "user" as const,
		autoLaunchSource: "user" as const,
		executablePathSource: "default" as const,
	};
}

test("selected pages remain scoped to their session manager", async () => {
	const firstOwner = {};
	const secondOwner = {};
	const previousAutoLaunch = state.autoLaunchEnabled;
	state.autoLaunchEnabled = false;
	syncManagedBrowserSettings(firstOwner, endpointFixture(9333));
	syncManagedBrowserSettings(secondOwner, endpointFixture(9444));
	const restore = setBrowserManagerOperationsForTests({
		fetch: async (input) => {
			const url = new URL(input);
			if (url.pathname === "/json/version") return new Response("{}", { status: 200 });
			const pagePrefix = url.port === "9333" ? "first" : "second";
			return new Response(
				JSON.stringify([
					{
						id: `${pagePrefix}-default`,
						title: "Default",
						type: "page",
						url: "about:blank",
						webSocketDebuggerUrl: `ws://127.0.0.1/${pagePrefix}-default`,
					},
					...(pagePrefix === "first"
						? [
								{
									id: "first-selected",
									title: "Selected",
									type: "page",
									url: "https://first.test",
									webSocketDebuggerUrl: "ws://127.0.0.1/first-selected",
								},
							]
						: []),
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
	});
	try {
		setActivePageId(firstOwner, "first-selected");
		setActivePageId(secondOwner, "missing-in-second");
		assert.equal(
			(await resolvePage(undefined, { sessionOwner: secondOwner })).id,
			"second-default",
		);
		assert.equal((await resolvePage(undefined, { sessionOwner: firstOwner })).id, "first-selected");
	} finally {
		setActivePageId(firstOwner, undefined);
		setActivePageId(secondOwner, undefined);
		state.autoLaunchEnabled = previousAutoLaunch;
		restore();
	}
});

test("times out and aborts bounded event listeners without affecting later events", async () => {
	const { client, socket } = await connectClient();
	await assert.rejects(
		client.waitForEvent("Runtime.executionContextCreated", (_value): _value is unknown => true, {
			timeoutMs: 5,
		}),
		/Timed out waiting for CDP event/u,
	);

	const controller = new AbortController();
	const aborted = client.waitForEvent(
		"Page.frameNavigated",
		(_value): _value is unknown => true,
		{
			signal: controller.signal,
			timeoutMs: 100,
		},
	);
	controller.abort(new Error("cancel event wait"));
	await assert.rejects(aborted, /cancel event wait/u);

	const next = client.waitForEvent(
		"Page.frameNavigated",
		(value): value is { frame: { url: string } } =>
			typeof value === "object" &&
			value !== null &&
			(value as { frame?: { url?: unknown } }).frame?.url === "https://next.test",
		{ timeoutMs: 100 },
	);
	socket.message({
		method: "Page.frameNavigated",
		params: { frame: { id: "frame", url: "https://next.test" } },
	});
	assert.equal((await next).frame.url, "https://next.test");
	client.close();
});

test("malformed messages and target detachment reject pending work", async () => {
	const malformed = await connectClient();
	const pendingMalformed = malformed.client.send("Page.enable", {}, { timeoutMs: 100 });
	malformed.socket.message("{not json");
	await assert.rejects(pendingMalformed, /malformed JSON/u);
	assert.throws(() => malformed.client.send("Page.enable"), /WebSocket is closed/u);

	const detached = await connectClient();
	const pendingDetached = detached.client.send("Page.enable", {}, { timeoutMs: 100 });
	detached.socket.message({
		method: "Inspector.detached",
		params: { reason: "target_closed" },
	});
	await assert.rejects(pendingDetached, /target detached.*target_closed/u);
});

test("oversized messages close the socket before parsing and reject pending work", async () => {
	const { client, socket } = await connectClient();
	const command = client.send("Page.enable", {}, { timeoutMs: 100 });
	socket.message("x".repeat(8 * 1024 * 1024 + 1));

	await assert.rejects(command, /message exceeds the 8 MB limit/u);
	assert.equal(socket.closeCalls, 1);
	assert.throws(() => client.send("Page.disable"), /WebSocket is closed/u);
});

test("an oversized unsolicited event closes a waiter-free socket", async () => {
	const { client, socket } = await connectClient();
	socket.message("x".repeat(8 * 1024 * 1024 + 1));

	assert.equal(socket.closeCalls, 1);
	assert.throws(() => client.send("Page.enable"), /WebSocket is closed/u);
});

test("event floods fail closed instead of evicting earlier events", async () => {
	const { client, socket } = await connectClient();
	const command = client.send("Page.getFrameTree", {}, { timeoutMs: 100 });
	socket.message({ method: "Page.frameNavigated", params: { frame: { url: "first" } } });
	for (let index = 0; index < 32; index += 1) {
		socket.message({ method: "Page.frameNavigated", params: { frame: { url: `other-${index}` } } });
	}

	await assert.rejects(command, /buffered more than 32 Page\.frameNavigated events/u);
	assert.equal(socket.closeCalls, 1);
	assert.throws(() => client.send("Page.disable"), /WebSocket is closed/u);
});

test("close is idempotent and rejects every pending command and event", async () => {
	const { client, socket } = await connectClient();
	const command = client.send("Page.enable", {}, { timeoutMs: 100 });
	const event = client.waitForEvent(
		"Runtime.executionContextCreated",
		(_value): _value is unknown => true,
		{ timeoutMs: 100 },
	);
	client.close(new Error("test close"));
	client.close(new Error("second close"));

	await assert.rejects(command, /test close/u);
	await assert.rejects(event, /test close/u);
	assert.equal(socket.closeCalls, 1);
});