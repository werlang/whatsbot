import cors from 'cors';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { messageDispatcher } from './background/message-dispatcher.js';
import { appConfig } from './config/app-config.js';
import { HttpError } from './helpers/error.js';
import { Mysql } from './helpers/mysql.js';
import { sendSuccess } from './helpers/response.js';
import { errorMiddleware } from './middleware/error.js';
import { ScheduledMessage } from './model/scheduled-message.js';
import { createMessagesRouter } from './routes/messages.js';
import { createWhatsAppRouter } from './routes/whatsapp.js';
import { whatsappClientManager } from './services/whatsapp-client-manager.js';

const { host, port } = appConfig;

/**
 * Creates the configured WhatsBot API application.
 */
function createApp({
    scheduledMessageModel = ScheduledMessage,
    whatsappClient = whatsappClientManager,
} = {}) {
    const app = express();

    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use('/messages', createMessagesRouter({ scheduledMessageModel }));
    app.use('/whatsapp', createWhatsAppRouter({ whatsappClientManager: whatsappClient }));

    app.get('/ready', (req, res) => {
        sendSuccess(res, {
            status: 200,
            data: {
                ready: true,
                service: 'api',
                scheduler: appConfig.scheduler,
                whatsapp: {
                    authPath: appConfig.whatsapp.authPath,
                    clientId: appConfig.whatsapp.clientId,
                    puppeteerArgs: appConfig.whatsapp.puppeteerArgs,
                    sessionStatus: whatsappClient.getSessionState().status,
                },
            },
            message: 'WhatsBot API is ready.',
        });
    });

    app.use((req, res, next) => {
        next(new HttpError(404, 'I am sorry, but I think you are lost.'));
    });
    app.use(errorMiddleware);

    return app;
}

const app = createApp();
let shutdownHandlersRegistered = false;

/**
 * Starts the API HTTP server and the background runtime services.
 */
async function start({
    mysqlDriver = Mysql,
    whatsappClient = whatsappClientManager,
    dispatcher = messageDispatcher,
} = {}) {
    await mysqlDriver.waitForReady();
    await whatsappClient.initialize();

    const server = await new Promise((resolve, reject) => {
        const instance = app.listen(port, host, () => {
            console.log(`WhatsBot API running on http://${host}:${port}`);
            resolve(instance);
        });

        instance.on('error', reject);
    });

    dispatcher.start();
    registerShutdownHandlers({ server, whatsappClient, dispatcher });
    return server;
}

/**
 * Registers one-time process shutdown hooks for the long-lived runtime services.
 */
function registerShutdownHandlers({ server, whatsappClient, dispatcher }) {
    if (shutdownHandlersRegistered) {
        return;
    }

    shutdownHandlersRegistered = true;

    const shutdown = async signal => {
        try {
            dispatcher.stop();
            await whatsappClient.destroy().catch(() => {});
            await new Promise(resolve => {
                server.close(() => resolve());
            });
        } finally {
            process.exit(signal === 'SIGUSR2' ? 0 : 0);
        }
    };

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            shutdown(signal).catch(error => {
                console.error(`Failed to shut down the API cleanly after ${signal}:`, error);
                process.exit(1);
            });
        });
    }
}

/**
 * Returns true when the current module is executed as the Node entrypoint.
 */
function isEntrypoint(metaUrl) {
    return process.argv[1] === fileURLToPath(metaUrl);
}

if (isEntrypoint(import.meta.url)) {
    start().catch(error => {
        console.error('Failed to start the API server:', error);
        process.exit(1);
    });
}

export { app, createApp, start };
