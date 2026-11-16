import { normalizeBaseUrl } from './url.js';
import { VERSION } from './version.js';

/**
 * A thin client over the public /v1 API (docs/openapi.yaml). It holds no business logic: it
 * sends the key, reads the error envelope `{"error": {"code", "message"}}` and returns JSON.
 */

/** The API answered with an error status. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'ApiError';
	}
}

/** No usable answer: the API could not be reached, timed out, or sent something that is not JSON. */
export class TransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TransportError';
	}
}

export type Query = Record<string, string | number | undefined>;

/** What the tools need from the API. A remote host can supply its own, such as one per caller. */
export interface LabelKitApi {
	get(path: string, query?: Query): Promise<unknown>;
}

export type ClientOptions = {
	apiKey: string;
	baseUrl: string;
	/** For tests. Defaults to the global `fetch`. */
	fetch?: typeof fetch;
	timeoutMs?: number;
};

export class LabelKitClient implements LabelKitApi {
	readonly #apiKey: string;
	readonly #baseUrl: string;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;

	constructor(options: ClientOptions) {
		this.#apiKey = options.apiKey;
		this.#baseUrl = normalizeBaseUrl(options.baseUrl);
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#timeoutMs = options.timeoutMs ?? 30_000;
	}

	/** Anything that could carry the key, removed from text that may be shown to a model or a log. */
	#redact(text: string): string {
		return text.split(this.#apiKey).join('[redacted]');
	}

	async get(path: string, query: Query = {}): Promise<unknown> {
		const url = new URL(this.#baseUrl + path);
		for (const [name, value] of Object.entries(query)) {
			if (value !== undefined) url.searchParams.set(name, String(value));
		}

		let response: Response;
		try {
			response = await this.#fetch(url, {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${this.#apiKey}`,
					Accept: 'application/json',
					'User-Agent': `labelkit-co/${VERSION}`
				},
				// The API does not redirect. Following one would send the key somewhere new.
				redirect: 'error',
				signal: AbortSignal.timeout(this.#timeoutMs)
			});
		} catch (e) {
			const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
			const cause = (e as { cause?: { code?: string } }).cause?.code;
			throw new TransportError(
				this.#redact(
					timedOut
						? `The LabelKit API at ${url.origin} did not answer within ${this.#timeoutMs / 1000} seconds.`
						: `Could not reach the LabelKit API at ${url.origin}${cause ? ` (${cause})` : ''}.`
				)
			);
		}

		const text = await response.text();
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			body = undefined;
		}

		if (!response.ok) {
			const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
			throw new ApiError(
				response.status,
				typeof error?.code === 'string' ? error.code : 'http_error',
				this.#redact(
					typeof error?.message === 'string'
						? error.message
						: `The API answered ${response.status}.`
				)
			);
		}
		if (body === undefined)
			throw new TransportError('The LabelKit API answered with something that is not JSON.');
		return body;
	}
}
