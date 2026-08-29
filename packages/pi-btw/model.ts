/**
 * Side-model resolution: honor the configured pi-btw.json model with graceful
 * fallback to the current session model, plus the provider streaming adapter.
 */

import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { parseBtwModelReference, type BtwSettings } from "./settings.ts";
import type { CompleteSimpleFunction, SideQuestionAuth } from "./side-thread.ts";
import { sanitizeSingleLine } from "./text.ts";

export interface ResolvedBtwModel {
	model: Model<Api>;
	auth: SideQuestionAuth;
}

/**
 * Stream a simple completion through the provider registered in the model
 * registry — the same path pi uses for its own single-shot requests.
 */
export function createModelCompleteSimple(
	modelRegistry: Pick<ModelRegistry, "getProvider">,
): CompleteSimpleFunction {
	return async (model, context, options) => {
		const provider = modelRegistry.getProvider(model.provider);
		if (!provider) {
			throw new Error(`No provider registered for model provider: ${model.provider}`);
		}
		return provider.streamSimple(model, context, options).result();
	};
}

type BtwModelRegistry = Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">;

export interface ResolveBtwModelOptions {
	settings: BtwSettings;
	currentModel: Model<Api> | undefined;
	modelRegistry: BtwModelRegistry;
	warn?: (message: string) => void;
}

/**
 * Resolve the side model: settings.model when it exists in the registry and
 * has request credentials, otherwise the current session model. Returns
 * undefined when no usable model remains; warns before every fallback.
 */
export async function resolveBtwModel({
	settings,
	currentModel,
	modelRegistry,
	warn,
}: ResolveBtwModelOptions): Promise<ResolvedBtwModel | undefined> {
	const reportWarning = (message: string) => warn?.(sanitizeSingleLine(message));
	if (settings.model) {
		const fallback = currentModel
			? `${currentModel.provider}/${currentModel.id}`
			: "the current model";
		const reference = parseBtwModelReference(settings.model);
		if (!reference) {
			reportWarning(`pi-btw model ${settings.model} is invalid; falling back to ${fallback}.`);
			return resolveBtwModel({ settings: {}, currentModel, modelRegistry, warn: reportWarning });
		}
		const configuredModel = modelRegistry.find(reference.provider, reference.modelId);
		if (!configuredModel) {
			reportWarning(`pi-btw model ${settings.model} was not found; falling back to ${fallback}.`);
		} else {
			const sameAsCurrent =
				configuredModel === currentModel ||
				(configuredModel.provider === currentModel?.provider &&
					configuredModel.id === currentModel.id);
			const fallbackAction = sameAsCurrent
				? "no distinct current model is available"
				: `falling back to ${fallback}`;
			try {
				const auth = await modelRegistry.getApiKeyAndHeaders(configuredModel);
				if (auth.ok && hasRequestAuth(auth)) return { model: configuredModel, auth };
				const reason = auth.ok ? "has no request credentials" : auth.error;
				reportWarning(
					`pi-btw model ${settings.model} is unavailable (${reason}); ${fallbackAction}.`,
				);
			} catch (error: unknown) {
				reportWarning(
					`pi-btw model ${settings.model} credentials failed (${formatError(error)}); ${fallbackAction}.`,
				);
			}
			if (sameAsCurrent) return undefined;
		}
	}

	if (!currentModel) return undefined;
	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(currentModel);
		if (auth.ok && hasRequestAuth(auth)) return { model: currentModel, auth };
	} catch {
		// The caller reports the final lack of an available model.
	}
	return undefined;
}

function hasRequestAuth(auth: SideQuestionAuth): boolean {
	return Boolean(
		auth.apiKey ||
			providerHeadersHaveValue(auth.headers) ||
			(auth.env && Object.keys(auth.env).length > 0),
	);
}

function providerHeadersHaveValue(headers: ProviderHeaders | undefined): boolean {
	return headers !== undefined && Object.values(headers).some((value) => value !== null);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}