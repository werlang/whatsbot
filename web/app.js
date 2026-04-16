import express from 'express';
import mustacheExpress from 'mustache-express';
import { fileURLToPath } from 'node:url';
import { renderMiddleware } from './middleware/render.js';

const viewsPath = new URL('./public/html/', import.meta.url).pathname;
const publicPath = new URL('./public/', import.meta.url).pathname;
const app = createApp();

const port = 3000;
const host = '0.0.0.0';

/**
 * Creates the configured WhatsBot web application.
 */
function createApp() {
    const application = express();

    application.use(express.json());
    application.use(express.urlencoded({ extended: true }));

    application.engine('html', mustacheExpress());
    application.set('view engine', 'html');
    application.set('views', viewsPath);

    application.use(renderMiddleware({
        apiUrl: process.env.API_URL,
        webUrl: process.env.WEB_URL,
        siteName: 'WhatsBot',
        year: new Date().getFullYear(),
    }));

    /**
     * Renders the scheduler home page.
     */
    application.get('/', (req, res) => {
        res.templateRender('index', {
            metaTitle: 'WhatsBot · Scheduled WhatsApp delivery',
            metaDescription: 'Schedule one WhatsApp message to a phone number, contact, or group, then monitor the current pairing session and QR status from the same page.',
            canonicalPath: '/',
            heading: 'Schedule one WhatsApp message.',
            intro: 'Pick a synced contact or group, or type a destination number manually, then choose the local date and time and let the API queue the delivery.',
            schedulerHint: 'The browser converts your chosen local time into a timezone-aware timestamp before the request is sent to the API.',
            sessionHint: 'Keep an eye on the live session state below so you know whether WhatsApp is already paired or still waiting for a QR scan.',
        });
    });

    /**
     * Renders the dedicated WhatsApp login and pairing flow.
     */
    application.get('/login', (req, res) => {
        res.templateRender('login', {
            metaTitle: 'WhatsBot · Login',
            metaDescription: 'Create one WhatsApp session, scan the QR code, and pair this app session without opening the scheduler UI.',
            canonicalPath: '/login',
            heading: 'Create one WhatsApp app session.',
            intro: 'Use this page to create and pair an isolated WhatsApp session for one person. Each session can later schedule messages independently.',
        });
    });

    /**
     * Serves the web readiness probe for local smoke checks.
     */
    application.get('/ready', (req, res) => {
        res.json({
            error: false,
            status: 200,
            data: {
                ready: true,
                service: 'web',
            },
            message: 'WhatsBot web is ready.',
        });
    });

    application.use(express.static(publicPath));

    /**
     * Handles all other routes with a 404 response
     */
    application.use((req, res) => {
        res.status(404).send('404 Not Found');
    });

    return application;
}

/**
 * Starts the web HTTP server.
 */
function start() {
    return new Promise((resolve, reject) => {
        const server = app.listen(port, host, () => {
            console.log('WhatsBot web running on http://' + host + ':' + port);
            resolve(server);
        });

        server.on('error', reject);
    });
}

/**
 * Returns true when the current module is executed as the Node entrypoint.
 */
const isEntrypoint = (metaUrl) => process.argv[1] === fileURLToPath(metaUrl);
if (isEntrypoint(import.meta.url)) {
    start().catch(function(error) {
        console.error('Failed to start the web server:', error);
        process.exit(1);
    });
}

export { app, createApp, start };
