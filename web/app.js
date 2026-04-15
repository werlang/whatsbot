import express from "express";
import mustacheExpress from "mustache-express";
import { fileURLToPath } from "node:url";
import { appConfig } from "./config/app-config.js";
import { renderMiddleware } from "./middleware/render.js";

const viewsPath = new URL("./src/html/", import.meta.url).pathname;
const publicPath = new URL("./public/", import.meta.url).pathname;
const app = createApp();

/**
 * Creates the configured WhatsBot web application.
 */
function createApp() {
    const application = express();

    application.use(express.json());
    application.use(express.urlencoded({ extended: true }));

    application.engine("html", mustacheExpress());
    application.set("view engine", "html");
    application.set("views", viewsPath);

    application.use(renderMiddleware({
        apiUrl: appConfig.apiUrl,
        webUrl: appConfig.webUrl,
        siteName: appConfig.siteName,
        year: new Date().getFullYear(),
    }));

    /**
     * Renders the scheduler home page.
     */
    application.get("/", renderHomePage);

    /**
     * Serves the web readiness probe for local smoke checks.
     */
    application.get("/ready", renderReadyPage);

    application.use(express.static(publicPath));
    application.use(notFoundHandler);

    return application;
}

/**
 * Renders the main scheduler page.
 */
function renderHomePage(req, res) {
    res.templateRender("index", {
        metaTitle: appConfig.siteName + " · Scheduled WhatsApp delivery",
        metaDescription: "Schedule one WhatsApp message, then monitor the current pairing session and QR status from the same page.",
        canonicalPath: "/",
        heading: "Schedule one WhatsApp message.",
        intro: "Enter the destination number, write the message, choose the local date and time, and let the API queue the delivery.",
        schedulerHint: "The browser converts your chosen local time into a timezone-aware timestamp before the request is sent to the API.",
        sessionHint: "Keep an eye on the live session state below so you know whether WhatsApp is already paired or still waiting for a QR scan.",
    });
}

/**
 * Returns a minimal readiness payload for smoke checks.
 */
function renderReadyPage(req, res) {
    res.json({
        error: false,
        status: 200,
        data: {
            ready: true,
            service: "web",
        },
        message: "WhatsBot web is ready.",
    });
}

/**
 * Returns a plain-text 404 for unmatched web routes.
 */
function notFoundHandler(req, res) {
    res.status(404).send("404 Not Found");
}

/**
 * Starts the web HTTP server.
 */
function start(application = app) {
    return new Promise((resolve, reject) => {
        const server = application.listen(appConfig.port, appConfig.host, () => {
            console.log("WhatsBot web running on http://" + appConfig.host + ":" + appConfig.port);
            resolve(server);
        });

        server.on("error", reject);
    });
}

/**
 * Returns true when the current module is executed as the Node entrypoint.
 */
function isEntrypoint(metaUrl) {
    return process.argv[1] === fileURLToPath(metaUrl);
}

if (isEntrypoint(import.meta.url)) {
    start().catch(function(error) {
        console.error("Failed to start the web server:", error);
        process.exit(1);
    });
}

export { app, createApp, start };
