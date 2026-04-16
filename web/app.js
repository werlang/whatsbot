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
     * Renders the browser gateway that routes users to the correct page.
     */
    application.get('/', (req, res) => {
        res.templateRender('root', {
            metaTitle: 'WhatsBot · Redirecting',
            metaDescription: 'WhatsBot is opening your workspace.',
            canonicalPath: '/',
        });
    });

    /**
     * Renders the scheduler home page for one specific session.
     */
    application.get('/session/:id', (req, res) => {
        const sessionId = String(req.params.id || '').trim();

        res.templateRender('index', {
            metaTitle: 'WhatsBot · Scheduled WhatsApp delivery',
            metaDescription: 'Schedule one WhatsApp message.',
            canonicalPath: `/session/${sessionId || 'main'}`,
            heading: 'Schedule a message.',
            intro: 'Pick who, what, and when.',
            schedulerHint: 'Local time. Simple flow.',
            sessionHint: 'Live session status.',
            sessionId: sessionId || 'main',
        });
    });

    /**
     * Renders the dedicated WhatsApp login and pairing flow.
     */
    application.get('/login', (req, res) => {
        res.templateRender('login', {
            metaTitle: 'WhatsBot · Login',
            metaDescription: 'Create or restore one WhatsApp session.',
            canonicalPath: '/login',
            heading: 'Connect WhatsApp.',
            intro: 'New phone or saved code.',
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
