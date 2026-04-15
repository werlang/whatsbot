import { TemplateVar } from "./template-var.js";
import { Request } from "./request.js";

class ApiEndpointResolver {
    /**
     * Removes a trailing slash from an API base URL.
     */
    #sanitizeBaseUrl(url) {
        if (!url || typeof url !== "string") {
            return "";
        }

        return url.replace(/\/$/, "");
    }

    /**
     * Resolves the API base URL from template variables or meta tags.
     */
    #resolveApiUrl() {
        const fromTemplate = TemplateVar.get("apiUrl");
        if (fromTemplate) {
            return this.#sanitizeBaseUrl(fromTemplate);
        }

        const fromMeta = document.querySelector("meta[name=api-url]")?.getAttribute("content");
        if (fromMeta) {
            return this.#sanitizeBaseUrl(fromMeta);
        }

        return "";
    }

    /**
     * Normalizes a request path into one absolute API path.
     */
    #toAbsolutePath(path) {
        if (typeof path !== "string" || !path) {
            return "/";
        }

        return path.startsWith("/") ? path : "/" + path;
    }

    /**
     * Combines the API base URL and one endpoint path.
     */
    resolve(path) {
        return this.#resolveApiUrl() + this.#toAbsolutePath(path);
    }
}

/**
 * Normalizes API responses into one predictable frontend envelope.
 */
function normalizeEnvelope(response, payload) {
    if (payload && typeof payload === "object" && typeof payload.error === "boolean") {
        return {
            ok: !payload.error && response.ok,
            status: Number.isInteger(payload.status) ? payload.status : response.status,
            data: payload.data,
            message: payload.message || null,
            type: payload.type || null,
            raw: payload,
        };
    }

    return {
        ok: response.ok,
        status: response.status,
        data: payload,
        message: null,
        type: null,
        raw: payload,
    };
}

export class ApiClient {
    #request;
    #endpointResolver;

    /**
     * Creates an API client with pluggable request and endpoint helpers.
     */
    constructor(options = {}) {
        this.#request = options.request || new Request();
        this.#endpointResolver = options.endpointResolver || new ApiEndpointResolver();
    }

    /**
     * Executes one API request and returns one normalized response object.
     */
    async request(path, options = {}) {
        const endpoint = this.#endpointResolver.resolve(path);
        const method = typeof options.method === "string"
            ? options.method.toUpperCase()
            : "GET";
        const requestOptions = {
            headers: {
                Accept: "application/json",
                ...(options.headers || {}),
            },
        };

        try {
            const payload = await this.#dispatch(method, endpoint, options.body, requestOptions);
            return normalizeEnvelope({ ok: true, status: 200 }, payload);
        } catch (error) {
            if (error && error.status) {
                const normalized = normalizeEnvelope({ ok: false, status: error.status }, error.data);
                if (!normalized.ok && !normalized.message) {
                    normalized.message = "Could not process the request.";
                }

                return normalized;
            }

            return {
                ok: false,
                status: 0,
                data: null,
                message: "Could not connect to the server.",
                type: "NetworkError",
                raw: error,
            };
        }
    }

    /**
     * Dispatches one normalized request through the Request helper.
     */
    async #dispatch(method, endpoint, body, requestOptions) {
        switch (method) {
        case "GET":
            return await this.#request.get(endpoint, requestOptions);
        case "POST":
            return await this.#request.post(endpoint, body, requestOptions);
        case "PUT":
            return await this.#request.put(endpoint, body, requestOptions);
        case "DELETE":
            return await this.#request.delete(endpoint, requestOptions);
        default:
            throw new Error("Unsupported method: " + method);
        }
    }
}

export const apiClient = new ApiClient();

/**
 * Executes one request through the shared API client instance.
 */
export async function requestApi(path, options = {}) {
    return await apiClient.request(path, options);
}
