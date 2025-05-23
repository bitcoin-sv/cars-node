import express from 'express';
import db from './db';
import logger from './logger';
import { createAuthMiddleware } from '@bsv/auth-express-middleware';
import { createPaymentMiddleware } from '@bsv/payment-express-middleware';
import bodyParser from 'body-parser';
import routes from './routes';
import upload from './routes/upload';
import publicRoute from './routes/public';
import globalEviction from './routes/globalEviction';
import { initCluster } from './init-cluster';
import { startCronJobs } from './cron';
import timeout from 'connect-timeout';
import { makeWallet } from './utils/wallet';

const port = parseInt(process.env.CARS_NODE_PORT || '7777', 10);
const MAINNET_PRIVATE_KEY = process.env.MAINNET_PRIVATE_KEY;
const TESTNET_PRIVATE_KEY = process.env.TESTNET_PRIVATE_KEY;
const INIT_K3S = process.env.INIT_K3S;

if (!MAINNET_PRIVATE_KEY || !TESTNET_PRIVATE_KEY) {
    throw new Error('Missing CARS node testnet or mainnet private keys on startup.');
}
if (!process.env.TAAL_API_KEY_MAIN || !process.env.TAAL_API_KEY_TEST) {
    throw new Error('TAAL API keys not configured');
}

function haltOnTimedout(req, res, next) {
    if (!req.timedout) next()
}

async function main() {
    // Run migrations
    logger.info('Running database migrations...');
    await db.migrate.latest();
    logger.info('Migrations completed.');

    // We have two wallets: one on mainnet and one on testnet
    const mainnetWallet = await makeWallet('main', MAINNET_PRIVATE_KEY!)
    const testnetWallet = await makeWallet('test', TESTNET_PRIVATE_KEY!)

    if (INIT_K3S) {
        await initCluster();
    }
    startCronJobs(db, mainnetWallet, testnetWallet);

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
        (req as any).mainnetWallet = mainnetWallet;
        (req as any).testnetWallet = testnetWallet;
        next();
    });

    // Upload uses signed URLs, so is excluded from Authrite. Also, they are not logged for performance reasons (they are large).
    app.post('/api/v1/upload/:deploymentId/:signature', timeout('2h'), haltOnTimedout, upload);

    // Public queries are also not authenticated
    app.get('/api/v1/public', publicRoute)

    // Global outpoint eviction endpoint also not authenticated
    app.post('/api/v1/evict-globally', globalEviction)

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
    app.use(createAuthMiddleware({
        wallet: mainnetWallet,
        onCertificatesReceived: async (identityKey, certs) => {
            try {
                if (
                    certs.length === 1 &&
                    typeof certs[0].decryptedFields!.email === 'string'
                    && certs[0].certifier === '02cf6cdf466951d8dfc9e7c9367511d0007ed6fba35ed42d425cc412fd6cfd4a17' &&
                    certs[0].type === 'exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA='
                ) {
                    await db('users').where('identity_key', '=', identityKey).update({
                        email: certs[0].decryptedFields!.email
                    })
                }
            } catch (e) {
                console.error('Error associating certificate with user', e)
            }
        },
        // certificatesToRequest: {
        //     types: {
        //         'exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA=': ['email']
        //     },
        //     certifiers: ['02cf6cdf466951d8dfc9e7c9367511d0007ed6fba35ed42d425cc412fd6cfd4a17']
        // }
    }));

    // Payment middleware (including request price calculator for balance top-ups), which uses mainnet wallet
    app.use(createPaymentMiddleware({
        wallet: mainnetWallet,
        calculateRequestPrice: (req: any) => {
            logger.info(`${req.path} .startsWith('/api/v1/project/') && req.path.endsWith('/pay')`)
            if (req.path.startsWith('/api/v1/project/') && req.path.endsWith('/pay')) {
                logger.info(`Request ${req.path} charging: ${req.body.amount} sats`)
                return req.body.amount
            } else {
                return 0
            }
        }
    }))

    app.use('/api/v1', routes);

    app.listen(port, () => {
        logger.info(`CARS Node listening on port ${port}`);
    });
}

main().catch(err => {
    logger.error(err, 'Error on startup');
    process.exit(1);
});
