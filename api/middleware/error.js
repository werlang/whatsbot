const ERROR_TYPES = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    500: 'Internal Server Error',
};

/**
 * Converts thrown errors into the API error envelope.
 */
function errorMiddleware(err, req, res, next) {
    if (!err) {
        next();
        return;
    }

    const status = Number.isInteger(err.status)
        ? err.status
        : (Number.isInteger(err.code) ? err.code : 500);

    const safeStatus = ERROR_TYPES[status] ? status : 500;
    const payload = {
        error: true,
        status: safeStatus,
        type: err.type || ERROR_TYPES[safeStatus],
        message: err.message || ERROR_TYPES[safeStatus],
    };

    if (process.env.NODE_ENV !== 'production' && err.data !== undefined && err.data !== null) {
        payload.data = err.data;
    }

    res.status(safeStatus).json(payload);
}

export { errorMiddleware };
