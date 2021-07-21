'use strict';

const Got = require('got');
const Hoek = require('@hapi/hoek');

/**
 * Prettify error message
 * @param  {Number} errorCode   Error code
 * @param  {String} errorReason Error message
 * @param  {String} caller      Name of method or call that caused the error
 * @return {Error}              Throws prettified error
 */
function throwError({ errorCode, errorReason, caller }) {
    const err = new Error(`${errorCode} Reason "${errorReason}" Caller "${caller}"`);

    err.status = errorCode;
    throw err;
}

const got = Got.extend({
    responseType: 'json',
    allowGetBody: true, // Allow us to pass prefixUrl, token, etc
    handlers: [
        (options, next) => {
            const { token, caller } = options;

            // Check auth token
            if (!token) {
                const errorCode = 403;
                const errorReason = 'Missing token for authentication';

                throwError({ errorCode, errorReason, caller });
            }

            // Set auth token
            if (!options.headers.authorization) {
                options.headers.authorization = `Bearer ${token}`;
            }

            // Skip streams
            if (options.isStream) {
                return next(options);
            }

            return (async () => {
                try {
                    const response = await next(options);

                    return response;
                } catch (error) {
                    // Handle errors
                    const { response } = error;
                    let errorCode = 500;
                    let errorReason = 'Internal server error';

                    if (response) {
                        errorCode = Hoek.reach(response, 'statusCode', {
                            default: 'SCM service unavailable.'
                        });
                        errorReason = Hoek.reach(response, 'body.message', {
                            default: JSON.stringify(response.body)
                        });
                    }

                    return throwError({ errorCode, errorReason, caller });
                }
            })();
        }
    ]
});

module.exports = got;
