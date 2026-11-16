/**
 * Request
 * Fetch wrapper with JSON headers and timeout handling.
 */
export class Request {
    #baseURL = "";
    #defaultHeaders = {
        "Content-Type": "application/json",
    };
    #timeout = 30000;

    /**
     * Creates a fetch wrapper with optional base URL, headers, and timeout.
     */
    constructor(options = {}) {
        if (options.baseURL !== undefined) {
            this.#baseURL = options.baseURL;
        }

        if (options.headers !== undefined) {
            this.#defaultHeaders = {
                ...this.#defaultHeaders,
                ...options.headers,
            };
        }

        if (options.timeout !== undefined) {
            this.#timeout = options.timeout;
        }
    }

    /**
     * Executes one HTTP request with a deadline covering headers and body parsing.
     */
    async #request(url, options = {}) {
        const controller = new AbortController();
        const externalSignal = options.signal;
        const abortFromCaller = function() {
            controller.abort();
        };

        if (externalSignal) {
            if (externalSignal.aborted) {
                controller.abort();
            } else {
                externalSignal.addEventListener("abort", abortFromCaller, { once: true });
            }
        }

        const timeoutId = setTimeout(function() {
            controller.abort();
        }, this.#timeout);

        try {
            const response = await fetch(this.#baseURL + url, {
                ...options,
                signal: controller.signal,
                headers: {
                    ...this.#defaultHeaders,
                    ...options.headers,
                },
            });

            const contentType = response.headers.get("content-type") || "";
            const parseBody = async function() {
                if (contentType.includes("application/json")) {
                    return await response.json();
                }

                if (contentType.includes("text/")) {
                    return await response.text();
                }

                return null;
            };

            if (!response.ok) {
                const errorData = await parseBody();
                const requestError = new Error("HTTP " + response.status + ": " + response.statusText);
                requestError.status = response.status;
                requestError.data = errorData;
                throw requestError;
            }

            return await parseBody();
        } catch (error) {
            if (error.name === "AbortError") {
                if (externalSignal?.aborted) {
                    const abortError = new Error("Request aborted");
                    abortError.name = "AbortError";
                    throw abortError;
                }

                throw new Error("Request timeout");
            }

            throw error;
        } finally {
            clearTimeout(timeoutId);
            externalSignal?.removeEventListener("abort", abortFromCaller);
        }
    }

    /**
     * Performs a GET request.
     */
    async get(url, options = {}) {
        return await this.#request(url, {
            ...options,
            method: "GET",
        });
    }

    /**
     * Performs a POST request.
     */
    async post(url, data, options = {}) {
        return await this.#request(url, {
            ...options,
            method: "POST",
            body: JSON.stringify(data),
        });
    }

    /**
     * Performs a PUT request.
     */
    async put(url, data, options = {}) {
        return await this.#request(url, {
            ...options,
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    /**
     * Performs a DELETE request.
     */
    async delete(url, options = {}) {
        return await this.#request(url, {
            ...options,
            method: "DELETE",
        });
    }
}
