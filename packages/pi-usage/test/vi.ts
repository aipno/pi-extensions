// Minimal vitest-compatible `vi` shim for `node --test`.
// Supports only the subset used by this package's tests:
// vi.fn, vi.spyOn, vi.stubGlobal, vi.unstubAllGlobals, plus
// mockResolvedValue(Once), mockImplementation(Once), mockRestore, mock.calls/results.

type AnyFunction = (...args: any[]) => any;

export type MockResult = { type: "return" | "throw"; value: unknown };

export type MockFunction<F extends AnyFunction> = F & {
	mock: {
		calls: Parameters<F>[];
		results: MockResult[];
	};
	mockImplementation(implementation: F): MockFunction<F>;
	mockImplementationOnce(implementation: F): MockFunction<F>;
	mockResolvedValue(value: Awaited<ReturnType<F>>): MockFunction<F>;
	mockResolvedValueOnce(value: Awaited<ReturnType<F>>): MockFunction<F>;
	mockReset(): void;
	mockRestore(): void;
};

export function createMockFunction<F extends AnyFunction>(
	implementation?: F,
	onRestore?: () => void,
): MockFunction<F> {
	let current: F | undefined = implementation;
	let once: F | undefined;
	const calls: Parameters<F>[] = [];
	const results: MockResult[] = [];

	const mocked = ((...args: Parameters<F>): ReturnType<F> => {
		const effective = once ?? current;
		calls.push(args);
		if (effective === undefined) throw new Error("mock function has no implementation");
		once = undefined;
		let value: unknown;
		try {
			value = effective(...args);
		} catch (error) {
			results.push({ type: "throw", value: error });
			throw error;
		}
		results.push({ type: "return", value });
		return value as ReturnType<F>;
	}) as MockFunction<F>;

	mocked.mock = { calls, results };
	mocked.mockImplementation = (implementationValue) => {
		current = implementationValue;
		return mocked;
	};
	mocked.mockImplementationOnce = (implementationValue) => {
		once = implementationValue;
		return mocked;
	};
	mocked.mockResolvedValue = (value) => {
		current = (async () => value) as F;
		return mocked;
	};
	mocked.mockResolvedValueOnce = (value) => {
		once = (async () => value) as F;
		return mocked;
	};
	mocked.mockReset = () => {
		calls.length = 0;
		results.length = 0;
	};
	mocked.mockRestore = () => {
		mocked.mockReset();
		current = implementation;
		once = undefined;
		onRestore?.();
	};
	return mocked;
}

const stubbedGlobals = new Map<string, unknown>();

export const vi = {
	fn<F extends AnyFunction>(implementation?: F): MockFunction<F> {
		return createMockFunction(implementation);
	},
	spyOn<T extends object, K extends keyof T & string>(
		object: T,
		method: K,
	): MockFunction<T[K] extends AnyFunction ? T[K] : AnyFunction> {
		const record = object as unknown as Record<string, unknown>;
		const original = record[method];
		if (typeof original !== "function") {
			throw new TypeError(`vi.spyOn: ${method} is not a function`);
		}
		const spy = createMockFunction(original as AnyFunction, () => {
			define(record, method, original);
		});
		define(record, method, spy);
		return spy as MockFunction<T[K] extends AnyFunction ? T[K] : AnyFunction>;
	},
	stubGlobal(name: string, value: unknown): void {
		if (!stubbedGlobals.has(name)) {
			stubbedGlobals.set(name, (globalThis as Record<string, unknown>)[name]);
		}
		define(globalThis as unknown as Record<string, unknown>, name, value);
	},
	unstubAllGlobals(): void {
		for (const [name, original] of stubbedGlobals) {
			define(globalThis as unknown as Record<string, unknown>, name, original);
		}
		stubbedGlobals.clear();
	},
};

function define(target: Record<string, unknown>, key: string, value: unknown): void {
	try {
		Object.defineProperty(target, key, {
			value,
			configurable: true,
			writable: true,
			enumerable: true,
		});
	} catch {
		target[key] = value;
	}
}