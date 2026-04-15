/**
 * Represents an internal application error with optional debug data.
 */
class CustomError extends Error {

    /**
     * Creates a new internal application error.
     */
    constructor(message = 'Internal Server Error', data = null) {
        super(message);
        this.name = 'CustomError';
        this.data = data;
    }
}

/**
 * Represents an HTTP error that is safe to expose to API consumers.
 */
class HttpError extends CustomError {

    /**
     * Creates a new HTTP error.
     */
    constructor(status = 500, message = 'Internal Server Error', data = null) {
        super(message, data);
        this.name = 'HttpError';
        this.status = Number.isInteger(Number(status)) ? Number(status) : 500;
        this.code = this.status;
        this.expose = true;
        this.type = null;
    }
}

export { CustomError, HttpError };
