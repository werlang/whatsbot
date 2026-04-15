/**
 * Normalizes a comma-separated environment variable into a list of trimmed values.
 */
function readList(value = '') {
    return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

/**
 * Reads one integer environment variable with a fallback value.
 */
function readInteger(value, fallback) {
    const parsedValue = Number.parseInt(value, 10);
    return Number.isFinite(parsedValue) ? parsedValue : fallback;
}

/**
 * Builds the runtime configuration used by the API service.
 */
function createAppConfig(env = process.env) {
    return {
        host: '0.0.0.0',
        port: readInteger(3000),
        mysql: {
            database: env.MYSQL_DATABASE || 'whatsbot',
        },
        scheduler: {
            pollIntervalMs: readInteger(env.SCHEDULER_POLL_INTERVAL_MS, 15000),
            batchSize: readInteger(env.SCHEDULER_BATCH_SIZE, 5),
            claimTimeoutMs: Math.max(readInteger(env.SCHEDULER_CLAIM_TIMEOUT_MS, 10 * 60 * 1000), 1000),
        },
        whatsapp: {
            clientId: 'main',
            authPath: '/whatsapp/auth',
            puppeteerArgs: readList('--no-sandbox,--disable-setuid-sandbox'),
            executablePath: '/usr/bin/chromium-browser',
        },
    };
}

const appConfig = createAppConfig();

export { appConfig, createAppConfig, readInteger, readList };
