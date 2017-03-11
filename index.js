/* eslint no-underscore-dangle: ["error", { "allowAfterThis": true }] */

'use strict';

const Breaker = require('circuit-fuses');
const Request = require('request');
const Hoek = require('hoek');
const Joi = require('joi');
const Schema = require('screwdriver-data-schema');
const Scm = require('screwdriver-scm-base');

const DEFAULT_AUTHOR = {
    avatar: 'https://cd.screwdriver.cd/assets/unknown_user.png',
    name: 'n/a',
    username: 'n/a',
    url: 'https://cd.screwdriver.cd/'
};

const MATCH_COMPONENT_HOSTNAME = 1;
const MATCH_COMPONENT_OWNER = 2;
const MATCH_COMPONENT_REPONAME = 3;
const MATCH_COMPONENT_BRANCH = 4;

const STATE_MAP = {
    SUCCESS: 'success',
    RUNNING: 'pending',
    QUEUED: 'pending'
};
const DESCRIPTION_MAP = {
    SUCCESS: 'Everything looks good!',
    FAILURE: 'Did not work as expected.',
    ABORTED: 'Aborted mid-flight',
    RUNNING: 'Testing your code...',
    QUEUED: 'Looking for a place to park...'
};

/**
 * Check the status code of the server's response.
 *
 * If there was an error encountered with the request, this will format a human-readable
 * error message.
 * @method checkResponseError
 * @param  {HTTPResponse}   response                               HTTP Response from `request` call
 * @param  {Number}         response.statusCode                    HTTP status code of the HTTP request
 * @param  {String}         [response.body.error.message]          Error message from the server
 * @param  {String}         [response.body.error.detail.required]  Error resolution message
 * @return {Promise}                                               Resolves when no error encountered.
 *                                                                 Rejects when status code is non-200
 */
function checkResponseError(response, caller) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
        return;
    }

    const errorCode = Hoek.reach(response, 'statusCode', {
        default: 'SCM service unavailable.'
    });
    const errorReason = Hoek.reach(response, 'body.message', {
        default: JSON.stringify(response.body)
    });

    throw new Error(`${errorCode} Reason "${errorReason}" Caller "${caller}"`);
}

/**
* Get repo information
* @method getRepoInfoByCheckoutUrl
* @param  {String}  checkoutUrl      The url to check out repo
* @return {Object}                   An object with the hostname, repo, branch, and owner
*/
function getRepoInfoByCheckoutUrl(checkoutUrl) {
    const regex = Schema.config.regex.CHECKOUT_URL;
    const matched = regex.exec(checkoutUrl);

    return {
        hostname: matched[MATCH_COMPONENT_HOSTNAME],
        reponame: matched[MATCH_COMPONENT_REPONAME],
        branch: matched[MATCH_COMPONENT_BRANCH].slice(1),
        owner: matched[MATCH_COMPONENT_OWNER]
    };
}

/**
 * Get hostname, repoId, and branch from scmUri
 * @method getScmUriParts
 * @param  {String}     scmUri
 * @return {Object}
 */
function getScmUriParts(scmUri) {
    const scm = {};

    [scm.hostname, scm.repoId, scm.branch] = scmUri.split(':');

    return scm;
}

class GitlabScm extends Scm {
    /**
    * Constructor
    * @method constructor
    * @param  {Object}  options                         Configuration options
    * @param  {String}  [options.gitlabHost=null]       If using Gitlab, the host/port of the deployed instance
    * @param  {String}  [options.gitlabProtocol=https]  If using Gitlab, the protocol to use
    * @param  {String}  [options.username=sd-buildbot]           Gitlab username for checkout
    * @param  {String}  [options.email=dev-null@screwdriver.cd]  Gitlab user email for checkout
    * @param  {Boolean} [options.https=false]           Is the Screwdriver API running over HTTPS
    * @param  {String}  options.oauthClientId           OAuth Client ID provided by Gitlab application
    * @param  {String}  options.oauthClientSecret       OAuth Client Secret provided by Gitlab application
    * @param  {Object}  [options.fusebox={}]            Circuit Breaker configuration
    * @return {GitlabScm}
    */
    constructor(config = {}) {
        super();

        // Validate configuration
        this.config = Joi.attempt(config, Joi.object().keys({
            gitlabProtocol: Joi.string().optional().default('https'),
            gitlabHost: Joi.string().optional().default('gitlab.com'),
            username: Joi.string().optional().default('sd-buildbot'),
            email: Joi.string().optional().default('dev-null@screwdriver.cd'),
            https: Joi.boolean().optional().default(false),
            oauthClientId: Joi.string().required(),
            oauthClientSecret: Joi.string().required(),
            fusebox: Joi.object().default({})
        }).unknown(true), 'Invalid config for Gitlab');

        const gitlabConfig = {};

        if (this.config.gitlabHost) {
            gitlabConfig.host = this.config.gitlabHost;
            gitlabConfig.protocol = this.config.gitlabProtocol;
            gitlabConfig.pathPrefix = '';
        }

        this.breaker = new Breaker(Request, this.config.fusebox);
    }

    /**
    * Look up a repo by SCM URI
    * @method lookupScmUri
    * @param  {Object}     config Config object
    * @param  {Object}     config.scmUri The SCM URI to look up relevant info
    * @param  {Object}     config.token  Service token to authenticate with Gitlab
    * @return {Promise}                  Resolves to an object containing
    *                                    repository-related information
    */
    lookupScmUri(config) {
        const scmInfo = getScmUriParts(config.scmUri);

        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3` +
                 `/projects/${scmInfo.repoId}`
        }).then((response) => {
            checkResponseError(response, 'lookupScmUri');

            const [owner, reponame] = response.body.path_with_namespace.split('/');

            return {
                branch: scmInfo.branch,
                hostname: scmInfo.hostname,
                reponame,
                owner
            };
        });
    }

    /**
     * Look up a webhook from a repo
     * @method _findWebhook
     * @param  {Object}     config
     * @param  {Object}     config.scmUri       Data about repo
     * @param  {String}     config.token        The SCM URI to find the webhook from
     * @param  {String}     config.url          url for webhook notifications
     * @return {Promise}                        Resolves a list of hooks
     */
    _findWebhook(config) {
        const repoInfo = getScmUriParts(config.scmUri);

        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3` +
                 `/projects/${repoInfo.repoId}/hooks`
        }).then((response) => {
            checkResponseError(response, '_findWebhook');

            const screwdriverHook = response.body.find(hook =>
                Hoek.reach(hook, 'url') === config.url
            );

            return screwdriverHook;
        });
    }

    /**
     * Create or edit a webhook (edits if hookInfo exists)
     * @method _createWebhook
     * @param  {Object}     config
     * @param  {Object}     [config.hookInfo]   Information about a existing webhook
     * @param  {Object}     config.scmUri       Information about the repo
     * @param  {String}     config.token        admin token for repo
     * @param  {String}     config.url          url for webhook notifications
     * @return {Promise}                        resolves when complete
     */
    _createWebhook(config) {
        const repoInfo = getScmUriParts(config.scmUri);
        const params = {
            url: config.url,
            push_events: true,
            merge_requests_events: true
        };
        const action = {
            method: 'POST',
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3` +
                 `/projects/${repoInfo.repoId}/hooks`
        };

        if (config.hookInfo) {
            action.method = 'PUT';
            action.url += `/${config.hookInfo.id}`;
        }

        return this.breaker.runCommand({
            json: true,
            method: action.method,
            auth: {
                bearer: config.token
            },
            url: action.url,
            qs: params
        });
    }

    /** Extended from screwdriver-scm-base **/

    /**
     * Adds the Screwdriver webhook to the Gitlab repository
     * @method _addWebhook
     * @param  {Object}    config            Config object
     * @param  {String}    config.scmUri     The SCM URI to add the webhook to
     * @param  {String}    config.token      Service token to authenticate with Gitlab
     * @param  {String}    config.webhookUrl The URL to use for the webhook notifications
     * @return {Promise}                     Resolve means operation completed without failure.
     */
    _addWebhook(config) {
        return this._findWebhook({
            scmUri: config.scmUri,
            url: config.webhookUrl,
            token: config.token
        }).then(hookInfo =>
            this._createWebhook({
                hookInfo,
                scmUri: config.scmUri,
                token: config.token,
                url: config.webhookUrl
            })
        );
    }

    /**
    * Parses a SCM URL into a screwdriver-representable ID
    * @method _parseUrl
    * @param  {Object}     config              Config object
    * @param  {String}     config.checkoutUrl  The checkoutUrl to parse
    * @param  {String}     config.token        The token used to authenticate to the SCM service
    * @return {Promise}                        Resolves to an ID of 'serviceName:repoId:branchName'
    */
    _parseUrl(config) {
        const repoInfo = getRepoInfoByCheckoutUrl(config.checkoutUrl);

        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3` +
                 `/projects/${repoInfo.owner}%2F${repoInfo.reponame}`
        }).then((response) => {
            checkResponseError(response, '_parseUrl');

            return `${repoInfo.hostname}:${response.body.id}:${repoInfo.branch}`;
        });
    }

    /**
     * Given a SCM webhook payload & its associated headers, aggregate the
     * necessary data to execute a Screwdriver job with.
     * @method _parseHook
     * @param  {Object}  payloadHeaders  The request headers associated with the
     *                                   webhook payload
     * @param  {Object}  webhookPayload  The webhook payload received from the
     *                                   SCM service.
     * @return {Promise}                 A key-map of data related to the received
     *                                   payload
     */
    _parseHook(payloadHeaders, webhookPayload) {
        const parsed = {};

        // console.log(`WOOF: header ${JSON.stringify(payloadHeaders, null, 2)}`);
        // console.log(`WOOF: payload ${JSON.stringify(webhookPayload, null, 2)}`);

        // hookId is not in header or payload
        parsed.hookId = null;

        switch (webhookPayload.object_kind) {
        case 'push': {
            if (webhookPayload.event_name !== 'push') {
                return Promise.resolve(null);
            }

            parsed.type = 'repo';
            parsed.action = 'push';
            parsed.username = webhookPayload.user_name;
            parsed.checkoutUrl = webhookPayload.project.git_http_url;
            parsed.branch = webhookPayload.ref.split('/').slice(-1)[0];
            parsed.sha = webhookPayload.checkout_sha;

            return Promise.resolve(parsed);
        }
        case 'merge_request': {
            const mergeRequest = webhookPayload.object_attributes;

            if (mergeRequest.state === 'opened') {
                parsed.action = 'opened';
            } else if (mergeRequest.state === 'reopened') {
                parsed.action = 'reopened';
            } else if (mergeRequest.state === 'closed' || mergeRequest.state === 'merged') {
                parsed.action = 'closed';
            } else {
                return Promise.resolve(null);
            }

            parsed.type = 'pr';
            parsed.username = webhookPayload.user.username;
            parsed.checkoutUrl = mergeRequest.source.git_http_url;
            parsed.branch = mergeRequest.target_branch;
            parsed.sha = mergeRequest.last_commit.id;
            parsed.prNum = mergeRequest.iid;
            parsed.prRef = mergeRequest.source_branch;

            return Promise.resolve(parsed);
        }
        default:
            return Promise.resolve(null);
        }
    }

    /**
    * Checkout the source code from a repository; resolves as an object with checkout commands
    * @method getCheckoutCommand
    * @param  {Object}    config
    * @param  {String}    config.branch        Pipeline branch
    * @param  {String}    config.host          Scm host to checkout source code from
    * @param  {String}    config.org           Scm org name
    * @param  {String}    config.repo          Scm repo name
    * @param  {String}    config.sha           Commit sha
    * @param  {String}    [config.prRef]       PR reference (can be a PR branch or reference)
    * @return {Promise}
    */
    _getCheckoutCommand(config) {
        const checkoutUrl = `${this.config.gitlabProtocol}://${config.host}` +
                            `/${config.org}/${config.repo}`;
        const checkoutRef = config.prRef ? config.branch : config.sha; // if PR, use pipeline branch
        const command = [];

        // Git clone
        command.push(`echo Cloning ${checkoutUrl}, on branch ${config.branch}`);
        command.push(`git clone --quiet --progress --branch ${config.branch} `
            + `${checkoutUrl} $SD_SOURCE_DIR`);
        // Reset to SHA
        command.push(`echo Reset to SHA ${checkoutRef}`);
        command.push(`git reset --hard ${checkoutRef}`);
        // Set config
        command.push('echo Setting user name and user email');
        command.push(`git config user.name ${this.config.username}`);
        command.push(`git config user.email ${this.config.email}`);

        // For pull requests
        if (config.prRef) {
            command.push(`echo Fetching PR and merging with ${config.branch}`);
            command.push(`git fetch origin ${config.prRef}`);
            command.push(`git merge ${config.sha}`);
        }

        return Promise.resolve({
            name: 'sd-checkout-code',
            command: command.join(' && ')
        });
    }

    /**
    * Decorate a given SCM URI with additional data to better display
    * related information. If a branch suffix is not provided, it will default
    * to the master branch
    * @method _decorateUrl
    * @param  {Config}    config        Configuration object
    * @param  {String}    config.scmUri The SCM URI the commit belongs to
    * @param  {String}    config.token  Service token to authenticate with Github
    * @return {Promise}
    */
    _decorateUrl(config) {
        return this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        }).then((scmInfo) => {
            const baseUrl = `${scmInfo.hostname}/${scmInfo.owner}/${scmInfo.reponame}`;

            return {
                branch: scmInfo.branch,
                name: `${scmInfo.owner}/${scmInfo.reponame}`,
                url: `${this.config.gitlabProtocol}://${baseUrl}/tree/${scmInfo.branch}`
            };
        });
    }

    /**
    * Decorate the commit based on the repository
    * @method _decorateCommit
    * @param  {Object}        config        Configuration object
    * @param  {Object}        config.scmUri SCM URI the commit belongs to
    * @param  {Object}        config.sha    SHA to decorate data with
    * @param  {Object}        config.token  Service token to authenticate with Github
    * @return {Promise}
    */
    _decorateCommit(config) {
        const commitLookup = this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        }).then(scmInfo =>
            this.breaker.runCommand({
                json: true,
                method: 'GET',
                auth: {
                    bearer: config.token
                },
                url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3` +
                     `/projects/${scmInfo.owner}%2F${scmInfo.reponame}` +
                     `/repository/commits/${config.sha}`
            }).then((response) => {
                checkResponseError(response, '_decorateCommit: commitLookup');

                return {
                    commitInfo: response.body,
                    scmInfo
                };
            })
        );

        const authorLookup = commitLookup.then((commitData) => {
            if (!commitData.commitInfo.author_name) {
                return DEFAULT_AUTHOR;
            }

            return this.decorateAuthor({
                token: config.token,
                username: commitData.commitInfo.author_name
            });
        });

        return Promise.all([
            commitLookup,
            authorLookup
        ]).then(([commitData, authorData]) =>
            ({
                author: authorData,
                message: commitData.commitInfo.message,
                url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}` +
                     `/${commitData.scmInfo.owner}/${commitData.scmInfo.reponame}` +
                     `/tree/${config.sha}`
            })
        );
    }

    /**
    * Decorate the author based on the Gitlab service
    * @method _decorateAuthor
    * @param  {Object}        config          Configuration object
    * @param  {Object}        config.token    Service token to authenticate with Gitlab
    * @param  {Object}        config.username Username to query more information for
    * @return {Promise}
    */
    _decorateAuthor(config) {
        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3` +
                 '/users',
            qs: {
                username: config.username
            }
        }).then((response) => {
            checkResponseError(response, '_decorateAuthor');

            const author = response.body[0];

            if (!author.username) {
                return DEFAULT_AUTHOR;
            }

            return {
                url: author.web_url,
                name: author.name,
                username: author.username,
                avatar: author.avatar_url
            };
        });
    }

    /**
    * Get a owners permissions on a repository
    * @method _getPermissions
    * @param  {Object}   config            Configuration
    * @param  {String}   config.scmUri     The scmUri to get permissions on
    * @param  {String}   config.token      The token used to authenticate to the SCM
    * @return {Promise}
    */
    _getPermissions(config) {
        const repoInfo = getScmUriParts(config.scmUri);

        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3` +
                 `/projects/${repoInfo.repoId}`
        }).then((response) => {
            checkResponseError(response, '_getPermissions');

            // TODO: trasnlate gitlab::access into admin, push, pull
            // ref: https://docs.gitlab.com/ee/api/members.html
            // "admin": false,
            // "push": false,
            // "pull": true

            return {
                admin: true,
                push: true,
                pull: true
            };
        });
    }

    /**
    * Get a commit sha for a specific repo#branch
    * @method getCommitSha
    * @param  {Object}   config            Configuration
    * @param  {String}   config.scmUri     The scmUri to get commit sha of
    * @param  {String}   config.token      The token used to authenticate to the SCM
    * @return {Promise}
    */
    _getCommitSha(config) {
        const repoInfo = getScmUriParts(config.scmUri);

        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3` +
                 `/projects/${repoInfo.repoId}/repository` +
                 `/branches/${repoInfo.branch}`
        }).then((response) => {
            checkResponseError(response, '_getCommitSha');

            return response.body.commit.id;
        });
    }

    /**
    * Update the commit status for a given repo and sha
    * @method updateCommitStatus
    * @param  {Object}   config              Configuration
    * @param  {String}   config.scmUri       The scmUri to get permissions on
    * @param  {String}   config.sha          The sha to apply the status to
    * @param  {String}   config.buildStatus  The build status used for figuring out the commit status to set
    * @param  {String}   config.token        The token used to authenticate to the SCM
    * @param  {String}   [config.jobName]    Optional name of the job that finished
    * @param  {String}   config.url          Target url
    * @return {Promise}
    */
    _updateCommitStatus(config) {
        const repoInfo = getScmUriParts(config.scmUri);
        const context = config.jobName ? `Screwdriver/${config.jobName}` : 'Screwdriver';

        return this.breaker.runCommand({
            json: true,
            method: 'POST',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3` +
                 `/projects/${repoInfo.repoId}/statuses/${config.sha}`,
            qs: {
                context,
                description: DESCRIPTION_MAP[config.buildStatus],
                state: STATE_MAP[config.buildStatus] || 'failure',
                target_url: config.url
            }
        }).then((response) => {
            checkResponseError(response, '_updateCommitStatus');
        });
    }

    /**
    * Fetch content of a file from gitlab
    * @method getFile
    * @param  {Object}   config              Configuration
    * @param  {String}   config.scmUri       The scmUri to get permissions on
    * @param  {String}   config.path         The file in the repo to fetch
    * @param  {String}   config.token        The token used to authenticate to the SCM
    * @param  {String}   config.ref          The reference to the SCM, either branch or sha
    * @return {Promise}
    */
    _getFile(config) {
        const repoInfo = getScmUriParts(config.scmUri);

        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3` +
                 `/projects/${repoInfo.repoId}/repository/files`,
            qs: {
                file_path: config.path,
                ref: config.ref || repoInfo.branch
            }
        }).then((response) => {
            checkResponseError(response, '_getFile');

            return new Buffer(response.body.content, response.body.encoding).toString();
        });
    }

    /**
     * Return a valid Bell configuration (for OAuth)
     * @method _getBellConfiguration
     * @return {Promise}
     */
    _getBellConfiguration() {
        const bellConfig = {
            provider: 'gitlab',
            clientId: this.config.oauthClientId,
            clientSecret: this.config.oauthClientSecret,
            isSecure: this.config.https,
            forceHttps: this.config.https
        };

        if (this.config.gitlabHost) {
            bellConfig.config = {
                uri: `${this.config.gitlabProtocol}://${this.config.gitlabHost}`
            };
        }

        return Promise.resolve(bellConfig);
    }

    /**
    * Retrieve stats for the executor
    * @method stats
    * @param  {Response} Object          Object containing stats for the executor
    */
    stats() {
        return this.breaker.stats();
    }

}

module.exports = GitlabScm;
