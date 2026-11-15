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
import { whatsappSessionManager } from './services/whatsapp-session-manager.js';

const { host, port } = appConfig;

/**
 * Creates the configured WhatsBot API application.
 */
function createApp({
    scheduledMessageModel = ScheduledMessage,
    whatsappClient = whatsappSessionManager,
    mysqlDriver = Mysql,
    dispatcher = messageDispatcher,
} = {}) {
    const app = express();

    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use('/messages', createMessagesRouter({
        scheduledMessageModel,
        whatsappClientManager: whatsappClient,
    }));
    app.use('/whatsapp', createWhatsAppRouter({ whatsappClientManager: whatsappClient }));

    app.get('/ready', async (req, res) => {
        const database = { ready: true, error: null };
        const reasons = [];
        try {
            await mysqlDriver.probe();
        } catch (error) {
            database.ready = false;
            database.error = String(error?.message || 'Database probe failed.');
            reasons.push(database.error);
        }
        const readySessionIds = whatsappClient.getReadySessionIds?.() || [];
        if (readySessionIds.length === 0) {
            reasons.push('No WhatsApp session is ready to send.');
        }
        const schedulerStatus = dispatcher.getStatus();
        if (schedulerStatus.lastError) {
            reasons.push(`Scheduler failed: ${schedulerStatus.lastError}`);
        }
        sendSuccess(res, {
            status: 200,
            data: {
                ready: reasons.length === 0,
                database,
                reasons,
                service: 'api',
                scheduler: { ...appConfig.scheduler, ...schedulerStatus },
                whatsapp: {
                    readySessionIds,
                    authPath: appConfig.whatsapp.authPath,
                    clientId: whatsappClient.getDefaultSessionId?.() || appConfig.whatsapp.clientId,
                    puppeteerArgs: appConfig.whatsapp.puppeteerArgs,
                    activeSessionCount: whatsappClient.getActiveSessionCount?.() || 0,
                    sessionStatus: whatsappClient.getKnownSessionState?.().status || "idle",
                },
            },
            message: reasons.length === 0 ? 'WhatsBot API is ready.' : 'WhatsBot API is not ready.',
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
    whatsappClient = whatsappSessionManager,
    dispatcher = messageDispatcher,
    listenPort = port,
} = {}) {
    // The HTTP API must become reachable before its dependencies are healthy. The WhatsApp
    // browser boot can take minutes and can fail outright (a corrupted Chromium profile makes
    // the injected bundle time out), and a database outage must not take the whole endpoint
    // down: readiness reports both cases while the server keeps answering.
    await mysqlDriver.waitForReady().catch(error => {
        console.error('Database is not ready at startup; /ready reports it:', error?.message || error);
    });

    const server = await new Promise((resolve, reject) => {
        const instance = app.listen(listenPort, host, () => {
            console.log(`WhatsBot API running on http://${host}:${listenPort}`);
            resolve(instance);
        });

        instance.on('error', reject);
    });

    const whatsappInitialization = whatsappClient.initialize().catch(error => {
        console.error('Failed to initialize the WhatsApp client:', error?.message || error);
        return null;
    });
    server.whatsappInitialization = whatsappInitialization;

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
