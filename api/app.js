import cors from "cors";
import express from "express";
import { fileURLToPath } from "node:url";
import { messageDispatcher } from "./background/message-dispatcher.js";
import { appConfig } from "./config/app-config.js";
import { HttpError } from "./helpers/error.js";
import { Mysql } from "./helpers/mysql.js";
import { sendSuccess } from "./helpers/response.js";
import { errorMiddleware } from "./middleware/error.js";
import { ScheduledMessage } from "./model/scheduled-message.js";
import { createMessagesRouter } from "./routes/messages.js";
import { createWhatsAppRouter } from "./routes/whatsapp.js";
import { whatsappClientManager } from "./services/whatsapp-client-manager.js";

/**
 * Creates the configured WhatsBot API application.
 */
function createApp({
    scheduledMessageModel = ScheduledMessage,
    whatsappClient = whatsappClientManager,
} = {}) {
    const application = express();

    application.use(cors());
    application.use(express.json());
    application.use(express.urlencoded({ extended: true }));

    application.use("/messages", createMessagesRouter({ scheduledMessageModel }));
    application.use("/whatsapp", createWhatsAppRouter({ whatsappClientManager: whatsappClient }));

    application.get("/ready", (req, res) => {
        sendSuccess(res, {
            status: 200,
            data: {
                ready: true,
                service: "api",
                timezone: appConfig.timezone,
                scheduler: appConfig.scheduler,
                whatsapp: {
                    authPath: appConfig.whatsapp.authPath,
                    clientId: appConfig.whatsapp.clientId,
                    puppeteerArgs: appConfig.whatsapp.puppeteerArgs,
                    sessionStatus: whatsappClient.getSessionState().status,
                },
            },
            message: "WhatsBot API is ready.",
        });
    });

    application.use((req, res, next) => {
        next(new HttpError(404, "I am sorry, but I think you are lost."));
    });
    application.use(errorMiddleware);

    return application;
}

const app = createApp();

/**
 * Starts the API HTTP server and the background runtime services.
 */
async function start({
    application = app,
    mysqlDriver = Mysql,
    whatsappClient = whatsappClientManager,
    dispatcher = messageDispatcher,
} = {}) {
    await mysqlDriver.waitForReady();
    await whatsappClient.initialize();

    const server = await new Promise((resolve, reject) => {
        const instance = application.listen(appConfig.port, appConfig.host, () => {
            console.log(`WhatsBot API running on http://${appConfig.host}:${appConfig.port}`);
            resolve(instance);
        });

        instance.on("error", reject);
    });

    dispatcher.start();
    return server;
}

/**
 * Returns true when the current module is executed as the Node entrypoint.
 */
function isEntrypoint(metaUrl) {
    return process.argv[1] === fileURLToPath(metaUrl);
}

if (isEntrypoint(import.meta.url)) {
    start().catch(error => {
        console.error("Failed to start the API server:", error);
        process.exit(1);
    });
}

export { app, createApp, start };
