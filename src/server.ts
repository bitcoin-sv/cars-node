import express from 'express';
import db from './db';
import logger from './logger';
import authrite from 'authrite-express';
import bodyParser from 'body-parser';
import { ProtoWallet, PrivateKey } from '@bsv/sdk';
import routes from './routes';
import upload from './routes/upload';
import { initCluster } from './init-cluster';

const port = parseInt(process.env.PORT || '7777', 10);
const SERVER_PRIVATE_KEY =
    process.env.SERVER_PRIVATE_KEY ||
    '6dcc124be5f382be631d49ba12f61adbce33a5ac14f6ddee12de25272f943f8b';
const SERVER_BASEURL = process.env.SERVER_BASEURL || 'http://localhost:7777';
const wallet = new ProtoWallet(new PrivateKey(SERVER_PRIVATE_KEY, 16));

async function main() {
    // Run migrations
    logger.info('Running database migrations...');
    await db.migrate.latest();
    logger.info('Migrations completed.');

    await initCluster();

    const app = express();

    app.use(bodyParser.json({ limit: '1gb' }));
    app.use(bodyParser.raw({ type: 'application/octet-stream', limit: '1gb' }));

    // CORS
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*')
        res.header('Access-Control-Allow-Headers', '*')
        res.header('Access-Control-Allow-Methods', '*')
        res.header('Access-Control-Expose-Headers', '*')
        if (req.method === 'OPTIONS') {
            return res.sendStatus(200)
        }
        next()
    });

    // Attach wallet and db to request context if needed
    app.use((req, res, next) => {
        (req as any).db = db;
        (req as any).wallet = wallet;
        next();
    });

    // Upload uses signed URLs, so is excluded from Authrite. Also, they are not logged for performance reasons (they are large).
    app.post('/api/v1/upload/:deploymentId/:signature', upload);

    // Logging middleware
    app.use((req, res, next) => {
        const startTime = Date.now();

        // Log incoming request details
        logger.info({ method: req.method, url: req.url }, 'Incoming Request');

        // Handle request body
        if (req.body && Object.keys(req.body).length > 0) {
            let bodyString;
            if (typeof req.body === 'object') {
                bodyString = JSON.stringify(req.body, null, 2);
                if (bodyString.length > 800) {
                    logger.info({ length: bodyString.length }, 'Request Body (object, truncated)')
                } else {
                    logger.info(req.body, 'Request Body')
                }
            } else if (Buffer.isBuffer(req.body)) {
                bodyString = req.body.toString('utf8');
                logger.info({ length: bodyString.length }, 'Request Body (raw, truncated)')
            }
        }

        // Intercept the res.send method
        const originalSend = res.send;
        let responseBody: any;

        res.send = function (body?: any): any {
            responseBody = body;
            return originalSend.call(this, body);
        };

        // Log outgoing response details after the response is finished
        res.on('finish', () => {
            const duration = Date.now() - startTime;
            logger.info({ method: req.method, url: req.url, statusCode: res.statusCode, duration }, 'Outgoing Response')

            // Handle response body
            if (responseBody) {
                let bodyString;
                if (typeof responseBody === 'object') {
                    bodyString = JSON.stringify(responseBody, null, 2);
                    if (bodyString.length > 800) {
                        logger.info({ length: bodyString.length }, 'Response Body (object, truncated)')
                    } else {
                        logger.info(responseBody, 'Response Body')
                    }
                } else if (Buffer.isBuffer(responseBody)) {
                    bodyString = responseBody.toString('utf8');
                    logger.info({ length: bodyString.length }, 'Response Body (raw, truncated)')
                } else if (typeof responseBody === 'string') {
                    bodyString = responseBody
                    if (bodyString.length > 800) {
                        logger.info({ length: bodyString.length }, 'Response Body (string, truncated)')
                    } else {
                        logger.info({ body: responseBody }, 'Response Body')
                    }
                }
            }
        });

        next();
    });

    // Authrite middleware
    app.use(authrite.middleware({
        serverPrivateKey: SERVER_PRIVATE_KEY,
        baseUrl: SERVER_BASEURL,
        requestedCertificates: {
            types: {
                'exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA=': ['email']
            },
            certifiers: ['03285263f06139b66fb27f51cf8a92e9dd007c4c4b83876ad6c3e7028db450a4c2']
        }
    }));

    app.use('/api/v1', routes);

    app.listen(port, () => {
        logger.info(`CARS Node listening on port ${port}`);
    });
}

main().catch(err => {
    logger.error(err, 'Error on startup');
    process.exit(1);
});