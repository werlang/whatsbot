/**
 * Builds the runtime configuration used by the web service.
 */
function createAppConfig(env = process.env) {
    return {
        host: env.WEB_HOST || '0.0.0.0',
        port: Number(env.PORT || 3000),
        apiUrl: env.API_URL || 'http://localhost:3000',
        webUrl: env.WEB_URL || 'http://localhost',
        siteName: env.SITE_NAME || 'WhatsBot',
        whatsappAuthPath: env.WHATSAPP_AUTH_PATH || '/app/storage/whatsapp-auth',
    };
}

const appConfig = createAppConfig();

export { appConfig, createAppConfig };
