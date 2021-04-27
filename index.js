/* eslint no-underscore-dangle: ["error", { "allowAfterThis": true }] */

'use strict';

const Breaker = require('circuit-fuses').breaker;
const Request = require('request');
const Hoek = require('@hapi/hoek');
const Joi = require('joi');
const Path = require('path');
const Schema = require('screwdriver-data-schema');
const Scm = require('screwdriver-scm-base');
const logger = require('screwdriver-logger');

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
const MATCH_COMPONENT_ROOTDIR = 5;

const STATE_MAP = {
    SUCCESS: 'success',
    RUNNING: 'running',
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

    const error = new Error(`${errorCode} Reason "${errorReason}" Caller "${caller}"`);

    error.status = errorCode;
    throw error;
}

/**
 * Get repo information
 * @method getRepoInfoByCheckoutUrl
 * @param  {String}  checkoutUrl      The url to check out repo
 * @param  {String}  [rootDir]        Root dir
 * @return {Object}                   An object with the hostname, repo, branch, owner, and rootDir
 */
function getRepoInfoByCheckoutUrl(checkoutUrl, rootDir) {
    const regex = Schema.config.regex.CHECKOUT_URL;
    const matched = regex.exec(checkoutUrl);

    const sourceDir = matched[MATCH_COMPONENT_ROOTDIR] ?
        matched[MATCH_COMPONENT_ROOTDIR].slice(1) : null;

    return {
        hostname: matched[MATCH_COMPONENT_HOSTNAME],
        reponame: matched[MATCH_COMPONENT_REPONAME],
        branch: matched[MATCH_COMPONENT_BRANCH] ? matched[MATCH_COMPONENT_BRANCH].slice(1) : null,
        owner: matched[MATCH_COMPONENT_OWNER],
        rootDir: rootDir || sourceDir
    };
}

/**
 * Get hostname, repoId, branch, and rootDir from scmUri
 * @method getScmUriParts
 * @param  {String}     scmUri
 * @return {Object}
 */
function getScmUriParts(scmUri) {
    const scm = {};

    [scm.hostname, scm.repoId, scm.branch, scm.rootDir] = scmUri.split(':');

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
    async lookupScmUri({ scmUri, token }) {
        const scmInfo = getScmUriParts(scmUri);

        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                 `/projects/${scmInfo.repoId}`
        }).then((response) => {
            checkResponseError(response, 'lookupScmUri');

            const [owner, reponame] = response.body.path_with_namespace.split('/');

            return {
                branch: scmInfo.branch,
                hostname: scmInfo.hostname,
                reponame,
                owner,
                rootDir: scmInfo.rootDir
            };
        });
    }

    /**
     * Get the webhook events mapping of screwdriver events and scm events
     * @method _getWebhookEventsMapping
     * @return {Object}     Returns a mapping of the events
     */
    _getWebhookEventsMapping() {
        return {
            pr: 'merge_requests_events',
            commit: 'push_events'
        };
    }

    /**
     * Look up a webhook from a repo
     * @async _findWebhook
     * @param  {Object}     config
     * @param  {Object}     config.scmUri       Data about repo
     * @param  {String}     config.token        The SCM URI to find the webhook from
     * @param  {String}     config.url          url for webhook notifications
     * @return {Promise}                        Resolves a list of hooks
     */
    async _findWebhook({ scmUri, token, url }) {
        const { repoId } = getScmUriParts(scmUri);

        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                 `/projects/${repoId}/hooks`
        }).then((response) => {
            checkResponseError(response, '_findWebhook');

            const hooks = response.body;
            const result = hooks.find(hook => hook.url === url);

            return result;
        });
    }

    /**
     * Create or edit a webhook (edits if hookInfo exists)
     * @async _createWebhook
     * @param  {Object}     config
     * @param  {Object}     [config.hookInfo]   Information about a existing webhook
     * @param  {Object}     config.scmUri       Information about the repo
     * @param  {String}     config.token        admin token for repo
     * @param  {String}     config.url          url for webhook notifications
     * @param  {String}     config.actions      Actions for the webhook events
     * @return {Promise}                        resolves when complete
     */
    async _createWebhook({ hookInfo, scmUri, token, url, actions }) {
        const { repoId } = getScmUriParts(scmUri);
        const params = {
            url,
            push_events: actions.length === 0 ?
                true : actions.includes('push_events'),
            merge_requests_events: actions.length === 0 ?
                true : actions.includes('merge_requests_events')
        };
        const action = {
            method: 'POST',
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                 `/projects/${repoId}/hooks`
        };

        if (hookInfo) {
            action.method = 'PUT';
            action.url += `/${hookInfo.id}`;
        }

        return this.breaker.runCommand({
            json: true,
            method: action.method,
            auth: {
                bearer: token
            },
            url: action.url,
            qs: params
        }).then((response) => {
            checkResponseError(response, '_createWebhook');
        });
    }

    /** Extended from screwdriver-scm-base */

    /**
     * Adds the Screwdriver webhook to the Gitlab repository
     * @async _addWebhook
     * @param  {Object}    config            Config object
     * @param  {String}    config.scmUri     The SCM URI to add the webhook to
     * @param  {String}    config.scmContext The scm conntext to which user belongs
     * @param  {String}    config.token      Service token to authenticate with Gitlab
     * @param  {String}    config.webhookUrl The URL to use for the webhook notifications
     * @param  {String}    config.actions    Actions for the webhook events
     * @return {Promise}                     Resolve means operation completed without failure.
     */
    async _addWebhook({ scmUri, token, webhookUrl, actions }) {
        return this._findWebhook({
            scmUri,
            url: webhookUrl,
            token
        }).then(hookInfo =>
            this._createWebhook({
                hookInfo,
                scmUri,
                token,
                url: webhookUrl,
                actions
            })
        );
    }

    /**
     * Parses a SCM URL into a screwdriver-representable ID
     * @method _parseUrl
     * @param  {Object}     config              Config object
     * @param  {String}     config.checkoutUrl  The checkoutUrl to parse
     * @param  {String}     config.token        The token used to authenticate to the SCM service
     * @param  {String}     [config.rootDir]    The root directory
     * @param  {String}     config.scmContext   The scm context to which user belongs
     * @return {Promise}                        Resolves to an ID of 'serviceName:repoId:branchName:rootDir'
     */
    async _parseUrl({ checkoutUrl, rootDir, token }) {
        const { hostname, owner, reponame, branch, rootDir: sourceDir } =
            getRepoInfoByCheckoutUrl(checkoutUrl, rootDir);
        const myHost = this.config.gitlabHost || 'gitlab.com';

        if (hostname !== myHost) {
            const message = 'This checkoutUrl is not supported for your current login host.';

            throw new Error(message);
        }

        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                 `/projects/${owner}%2F${reponame}`
        }).then((response) => {
            checkResponseError(response, '_parseUrl');

            const scmUri = `${hostname}:${response.body.id}:` +
                `${branch || response.body.default_branch}`;

            return sourceDir ? `${scmUri}:${sourceDir}` : scmUri;
        });
    }

    /**
     * Given a SCM webhook payload & its associated headers, aggregate the
     * necessary data to execute a Screwdriver job with.
     * @async _parseHook
     * @param  {Object}  payloadHeaders  The request headers associated with the
     *                                   webhook payload
     * @param  {Object}  webhookPayload  The webhook payload received from the
     *                                   SCM service.
     * @return {Promise}                 A key-map of data related to the received
     *                                   payload
     */
    async _parseHook(payloadHeaders, webhookPayload) {
        const scmContexts = this._getScmContexts();
        const scmContext = scmContexts[0];
        const hookId = ''; // hookId is not in header or payload
        const checkoutUrl = Hoek.reach(webhookPayload, 'project.git_ssh_url');
        const commitAuthors = [];
        const commits = Hoek.reach(webhookPayload, 'commits');
        const type = Hoek.reach(webhookPayload, 'object_kind');

        switch (type) {
        case 'merge_request': {
            const mergeRequest = Hoek.reach(webhookPayload, 'object_attributes');
            let action = Hoek.reach(mergeRequest, 'state');
            const prNum = Hoek.reach(mergeRequest, 'iid');
            const prTitle = Hoek.reach(mergeRequest, 'title');
            const baseSource = Hoek.reach(mergeRequest, 'target_project_id');
            const headSource = Hoek.reach(mergeRequest, 'source_project_id');
            const prSource = baseSource === headSource ? 'branch' : 'fork';
            const ref = `pull/${prNum}/merge`;

            // Possible actions
            // "opened", "closed", "locked", "merged"
            if (!['opened', 'closed', 'merged'].includes(action)) {
                return null;
            }

            if (action === 'merged') {
                action = 'closed';
            }

            return {
                action,
                branch: Hoek.reach(mergeRequest, 'target_branch'),
                checkoutUrl,
                prNum,
                prTitle,
                prRef: `merge_requests/${prNum}`,
                ref,
                prSource,
                sha: Hoek.reach(mergeRequest, 'last_commit.id'),
                type: 'pr',
                username: Hoek.reach(webhookPayload, 'user.username'),
                hookId,
                scmContext
            };
        }
        case 'push': {
            if (Array.isArray(commits)) {
                commits.forEach((commit) => {
                    commitAuthors.push(commit.author.name);
                });
            }

            return {
                action: 'push',
                branch: Hoek.reach(webhookPayload, 'ref').split('/').slice(-1)[0],
                checkoutUrl,
                sha: Hoek.reach(webhookPayload, 'checkout_sha'),
                type: 'repo',
                username: Hoek.reach(webhookPayload, 'user_username'),
                commitAuthors,
                lastCommitMessage: Hoek.reach(webhookPayload, 'commits.-1.message',
                    { default: '' }) || '',
                hookId,
                scmContext,
                ref: Hoek.reach(webhookPayload, 'ref')
            };
        }
        default:
            logger.info('%s event is not available yet in scm-gitlab plugin', type);

            return null;
        }
    }

    /**
     * Checkout the source code from a repository; resolves as an object with checkout commands
     * @async getCheckoutCommand
     * @param  {Object}    config
     * @param  {String}    config.branch            Pipeline branch
     * @param  {String}    config.host              Scm host to checkout source code from
     * @param  {String}    config.org               Scm org name
     * @param  {Object}    [config.parentConfig]    Config for parent pipeline
     * @param  {String}    [config.prRef]           PR reference (can be a PR branch or reference)
     * @param  {String}    config.repo              Scm repo name
     * @param  {String}    [config.rootDir]         Root directory
     * @param  {String}    config.sha               Commit sha
     * @param  {String}    [config.commitBranch] Commit branch
     * @return {Promise}
     */
    async _getCheckoutCommand({ branch: pipelineBranch, commitBranch, host, org,
        prRef: configPrRef, repo, rootDir, sha, parentConfig, prSource, prBranchName }) {
        // TODO: this needs to be fixed to support private / internal repos.
        const checkoutUrl = `${host}/${org}/${repo}`; // URL for https
        const sshCheckoutUrl = `git@${host}:${org}/${repo}`; // URL for ssh
        const branch = commitBranch || pipelineBranch; // use commit branch
        const checkoutRef = configPrRef ? branch : sha; // if PR, use pipeline branch
        const command = [];

        command.push("export SD_GIT_WRAPPER=\"$(if [ `uname` = 'Darwin' ]; " +
            "then echo 'eval'; " +
            "else echo 'sd-step exec core/git'; fi)\"");

        // Export environment variables
        command.push('echo Exporting environment variables');
        command.push('if [ ! -z $SCM_CLONE_TYPE ] && [ $SCM_CLONE_TYPE = ssh ]; ' +
            `then export SCM_URL=${sshCheckoutUrl}; ` +
            'elif [ ! -z $SCM_USERNAME ] && [ ! -z $SCM_ACCESS_TOKEN ]; ' +
            `then export SCM_URL=https://$SCM_USERNAME:$SCM_ACCESS_TOKEN@${checkoutUrl}; ` +
            `else export SCM_URL=https://${checkoutUrl}; fi`);
        command.push('export GIT_URL=$SCM_URL.git');
        // git 1.7.1 doesn't support --no-edit with merge, this should do same thing
        command.push('export GIT_MERGE_AUTOEDIT=no');

        // Set config
        command.push('echo Setting user name and user email');
        command.push(`$SD_GIT_WRAPPER "git config --global user.name ${this.config.username}"`);
        command.push(`$SD_GIT_WRAPPER "git config --global user.email ${this.config.email}"`);

        // Set final checkout dir, default to SD_SOURCE_DIR for backward compatibility
        command.push('export SD_CHECKOUT_DIR_FINAL=$SD_SOURCE_DIR');
        // eslint-disable-next-line max-len
        command.push('if [ ! -z $SD_CHECKOUT_DIR ]; then export SD_CHECKOUT_DIR_FINAL=$SD_CHECKOUT_DIR; fi');

        const shallowCloneCmd = 'else if [ ! -z "$GIT_SHALLOW_CLONE_SINCE" ]; '
        + 'then export GIT_SHALLOW_CLONE_DEPTH_OPTION='
        + '"--shallow-since=\'$GIT_SHALLOW_CLONE_SINCE\'"; '
        + 'else if [ -z $GIT_SHALLOW_CLONE_DEPTH ]; '
        + 'then export GIT_SHALLOW_CLONE_DEPTH=50; fi; '
        + 'export GIT_SHALLOW_CLONE_DEPTH_OPTION="--depth=$GIT_SHALLOW_CLONE_DEPTH"; fi; '
        + 'export GIT_SHALLOW_CLONE_BRANCH="--no-single-branch"; '
        + 'if [ "$GIT_SHALLOW_CLONE_SINGLE_BRANCH" = true ]; '
        + 'then export GIT_SHALLOW_CLONE_BRANCH=""; fi; '
        + '$SD_GIT_WRAPPER '
        + '"git clone $GIT_SHALLOW_CLONE_DEPTH_OPTION $GIT_SHALLOW_CLONE_BRANCH ';

        // Checkout config pipeline if this is a child pipeline
        if (parentConfig) {
            const parentCheckoutUrl = `${parentConfig.host}/${parentConfig.org}/`
                + `${parentConfig.repo}`; // URL for https
            const parentSshCheckoutUrl = `git@${parentConfig.host}:`
                + `${parentConfig.org}/${parentConfig.repo}`; // URL for ssh
            const parentBranch = parentConfig.branch;
            const externalConfigDir = '$SD_ROOT_DIR/config';

            command.push('if [ ! -z $SCM_CLONE_TYPE ] && [ $SCM_CLONE_TYPE = ssh ]; ' +
                `then export CONFIG_URL=${parentSshCheckoutUrl}; ` +
                'elif [ ! -z $SCM_USERNAME ] && [ ! -z $SCM_ACCESS_TOKEN ]; ' +
                'then export CONFIG_URL=https://$SCM_USERNAME:$SCM_ACCESS_TOKEN@'
                    + `${parentCheckoutUrl}; ` +
                `else export CONFIG_URL=https://${parentCheckoutUrl}; fi`);
            command.push(`export SD_CONFIG_DIR=${externalConfigDir}`);

            // Git clone
            command.push(`echo Cloning external config repo ${parentCheckoutUrl}`);
            command.push(`${'if [ ! -z $GIT_SHALLOW_CLONE ] && [ $GIT_SHALLOW_CLONE = false ]; '
                  + 'then $SD_GIT_WRAPPER '
                  + `"git clone --recursive --quiet --progress --branch ${parentBranch} `
                  + '$CONFIG_URL $SD_CONFIG_DIR"; '}${shallowCloneCmd}`
                  + `--recursive --quiet --progress --branch ${parentBranch} `
                  + '$CONFIG_URL $SD_CONFIG_DIR"; fi');
            // Reset to SHA
            command.push('$SD_GIT_WRAPPER "git -C $SD_CONFIG_DIR reset --hard '
                + `${parentConfig.sha} --"`);
            command.push(`echo Reset external config repo to ${parentConfig.sha}`);
        }

        // Git clone
        command.push(`echo 'Cloning ${checkoutUrl}, on branch ${branch}'`);
        command.push(`${'if [ ! -z $GIT_SHALLOW_CLONE ] && [ $GIT_SHALLOW_CLONE = false ]; '
              + 'then $SD_GIT_WRAPPER '
              + `"git clone --recursive --quiet --progress --branch '${branch}' `
              + '$SCM_URL $SD_CHECKOUT_DIR_FINAL"; '}${shallowCloneCmd}`
              + `--recursive --quiet --progress --branch '${branch}' `
              + '$SCM_URL $SD_CHECKOUT_DIR_FINAL"; fi');
        // Reset to SHA
        command.push(`$SD_GIT_WRAPPER "git reset --hard '${checkoutRef}' --"`);
        command.push(`echo 'Reset to ${checkoutRef}'`);

        // cd into rootDir after cloning
        if (rootDir) {
            command.push(`cd ${rootDir}`);
        }

        // For pull requests
        if (configPrRef) {
            const LOCAL_BRANCH_NAME = 'pr';
            const prRef = configPrRef.replace('merge', `head:${LOCAL_BRANCH_NAME}`);
            const baseRepo = prSource === 'fork' ? 'upstream' : 'origin';

            // Fetch a pull request
            command.push(`echo 'Fetching PR ${prRef}'`);
            command.push(`$SD_GIT_WRAPPER "git fetch origin ${prRef}"`);

            command.push(`export PR_BASE_BRANCH_NAME='${branch}'`);
            command.push(`export PR_BRANCH_NAME='${baseRepo}/${prBranchName}'`);

            command.push(`echo 'Checking out the PR branch ${prBranchName}'`);
            command.push(`$SD_GIT_WRAPPER "git checkout ${LOCAL_BRANCH_NAME}"`);
            command.push(`$SD_GIT_WRAPPER "git merge ${branch}"`);
            command.push(`export GIT_BRANCH=origin/refs/${prRef}`);
        } else {
            command.push(`export GIT_BRANCH='origin/${branch}'`);
        }

        // Init & Update submodule
        command.push('$SD_GIT_WRAPPER "git submodule init"');
        command.push('$SD_GIT_WRAPPER "git submodule update --recursive"');

        return Promise.resolve({
            name: 'sd-checkout-code',
            command: command.join(' && ')
        });
    }

    /**
     * Decorate a given SCM URI with additional data to better display
     * related information. If a branch suffix is not provided, it will default
     * to the default_branch
     * @method _decorateUrl
     * @param  {Config}    config            Configuration object
     * @param  {String}    config.scmUri     The SCM URI the commit belongs to
     * @param  {String}    config.token      Service token to authenticate with Github
     * @param  {String}    config.scmContext The scm context to which user belongs
     * @return {Promise}
     */
    async _decorateUrl({ scmUri, token }) {
        const { hostname, owner, reponame, branch, rootDir } = await this.lookupScmUri({
            scmUri,
            token
        });
        const baseUrl = `${hostname}/${owner}/${reponame}/-/tree/${branch}`;

        return {
            branch,
            name: `${owner}/${reponame}`,
            url: `${this.config.gitlabProtocol}://` +
                `${rootDir ? Path.join(baseUrl, rootDir) : baseUrl}`,
            rootDir: rootDir || ''
        };
    }

    /**
     * Decorate the commit based on the repository
     * @method _decorateCommit
     * @param  {Object}        config            Configuration object
     * @param  {Object}        config.scmUri     SCM URI the commit belongs to
     * @param  {Object}        config.sha        SHA to decorate data with
     * @param  {Object}        config.token      Service token to authenticate with Github
     * @param  {Object}        config.scmContext Context to which user belongs
     * @return {Promise}
     */
    async _decorateCommit({ scmUri, sha, token }) {
        const { owner, reponame } = await this.lookupScmUri({
            scmUri,
            token
        });

        const commit = await this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                 `/projects/${owner}%2F${reponame}` +
                 `/repository/commits/${sha}`
        });

        checkResponseError(commit, '_decorateCommit: commitLookup');

        const authorName = Hoek.reach(commit, 'body.author_name');
        const committerName = Hoek.reach(commit, 'body.committer_name');
        const author = Object.assign({}, DEFAULT_AUTHOR);
        const committer = Object.assign({}, DEFAULT_AUTHOR);

        if (authorName) {
            author.name = authorName;
        }

        if (committerName) {
            committer.name = committerName;
        }

        return {
            author,
            committer,
            message: commit.body.message,
            url: commit.body.web_url
        };
    }

    /**
     * Decorate the author based on the Gitlab service
     * @method _decorateAuthor
     * @param  {Object}        config            Configuration object
     * @param  {Object}        config.token      Service token to authenticate with Gitlab
     * @param  {Object}        config.username   Username to query more information for
     * @return {Promise}
     */
    async _decorateAuthor({ token, username }) {
        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                 '/users',
            qs: {
                username
            }
        }).then((response) => {
            checkResponseError(response, '_decorateAuthor');

            const author = Hoek.reach(response, 'body.0', {
                default: {
                    web_url: DEFAULT_AUTHOR.url,
                    name: DEFAULT_AUTHOR.name,
                    username: DEFAULT_AUTHOR.username,
                    avatar_url: DEFAULT_AUTHOR.avatar
                }
            });

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
     * @async _getPermissions
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUri     The scmUri to get permissions on
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @param  {String}   config.scmContext The scm context to which user belongs
     * @return {Promise}
     */
    async _getPermissions({ scmUri, token }) {
        const { repoId } = getScmUriParts(scmUri);

        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                 `/projects/${repoId}`
        }).then((response) => {
            checkResponseError(response, '_getPermissions');

            const result = {
                admin: false,
                push: false,
                pull: false
            };
            const permissions = response.body.permissions;
            const accessLevel = Hoek.reach(permissions, 'project_access.access_level', {
                default: 0
            });

            // ref: https://docs.gitlab.com/ee/api/members.html
            // ref: https://docs.gitlab.com/ee/user/permissions.html
            switch (accessLevel) {
            case 50: // Owner
                // falls through
            case 40: // Master
                result.admin = true;
                // falls through
            case 30: // Developer
                result.push = true;
                // falls through
            case 20: // reporter
                result.pull = true;
                // falls through
            case 10: // Guest
                // falls through
            default:
                break;
            }

            return result;
        });
    }

    /**
     * Get a users permissions on an organization; need for build clusters
     * @async _getOrgPermissions
     * @param  {Object}   config                  Configuration
     * @param  {String}   config.organization     The organization to get permissions on
     * @param  {String}   config.username         The user to check against
     * @param  {String}   config.token            The token used to authenticate to the SCM
     * @param  {String}   [config.scmContext]     The scm context name
     * @return {Promise}
     */
    async _getOrgPermissions() {
        return Promise.reject('Not implemented');
    }

    /**
     * Get a commit sha for a specific repo#branch
     * @async getCommitSha
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUri     The scmUri to get commit sha of
     * @param  {String}   config.scmContext The scm context to which user belongs
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @return {Promise}
     */
    async _getCommitSha({ scmUri, token }) {
        const { repoId, branch } = getScmUriParts(scmUri);

        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                 `/projects/${repoId}/repository` +
                 `/branches/${branch}`
        }).then((response) => {
            checkResponseError(response, '_getCommitSha');

            return response.body.commit.id;
        });
    }

    /**
     * Add merge request note
     * @async addPrComment
     * @param  {Object}   config            Configuration
     * @param  {String}   config.comment    The PR comment
     * @param  {Integer}  config.prNum      The PR number
     * @param  {String}   config.scmUri     The scmUri to get commit sha of
     * @param  {String}   config.scmContext The scm context to which user belongs
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @return {Promise}
     */
    async _addPrComment({ comment, prNum, scmUri, token }) {
        const { repoId } = getScmUriParts(scmUri);

        return this.breaker.runCommand({
            json: true,
            method: 'POST',
            auth: {
                bearer: token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                 `/projects/${repoId}/merge_requests/${prNum}/notes`,
            qs: {
                body: comment
            }
        }).then((response) => {
            checkResponseError(response, '_addPrComment');

            return {
                commentId: response.body.id,
                createTime: response.body.created_at,
                username: response.body.author.username
            };
        });
    }

    /**
     * Get a commit sha from a reference; will need this to support tag/release
     * @async  _getCommitRefSha
     * @param  {Object}   config
     * @param  {String}   config.token     The token used to authenticate to the SCM
     * @param  {String}   config.owner     The owner of the target repository
     * @param  {String}   config.repo      The target repository name
     * @param  {String}   config.ref       The reference which we want
     * @param  {String}   config.refType   The reference type. ex. branch is 'heads', tag is 'tags'.
     * @return {Promise}                   Resolves to the commit sha
     */
    async _getCommitRefSha() {
        return Promise.reject(new Error('Not implemented'));
    }

    /**
     * Update the commit status for a given repo and sha
     * @async updateCommitStatus
     * @param  {Object}   config              Configuration
     * @param  {String}   config.scmUri       The scmUri to get permissions on
     * @param  {String}   config.sha          The sha to apply the status to
     * @param  {String}   config.buildStatus  The build status used for figuring out the commit status to set
     * @param  {String}   config.token        The token used to authenticate to the SCM
     * @param  {String}   config.jobName      Optional name of the job that finished
     * @param  {String}   config.url          Target url
     * @param  {Number}   config.pipelineId   Pipeline Id
     * @param  {String}   config.context      Status context
     * @param  {String}   config.description  Status description
     * @return {Promise}
     */
    async _updateCommitStatus({ scmUri, jobName, token, sha, buildStatus, url,
        pipelineId, context, description }) {
        const repoInfo = getScmUriParts(scmUri);
        const statusTitle = context ? `Screwdriver/${pipelineId}/${context}` :
            `Screwdriver/${pipelineId}/${jobName.replace(/^PR-\d+/g, 'PR')}`; // (e.g. Screwdriver/12/PR:main)

        return this.breaker.runCommand({
            json: true,
            method: 'POST',
            auth: {
                bearer: token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                 `/projects/${repoInfo.repoId}/statuses/${sha}`,
            qs: {
                context: statusTitle,
                description: description || DESCRIPTION_MAP[buildStatus],
                state: STATE_MAP[buildStatus] || 'failure',
                target_url: url
            }
        }).then((response) => {
            checkResponseError(response, '_updateCommitStatus');
        });
    }

    /**
     * Fetch content of a file from gitlab
     * @async getFile
     * @param  {Object}   config              Configuration
     * @param  {String}   config.scmUri       The scmUri to get permissions on
     * @param  {String}   config.path         The file in the repo to fetch
     * @param  {String}   config.token        The token used to authenticate to the SCM
     * @param  {String}   [config.ref]        The reference to the SCM, either branch or sha
     * @param  {String}   config.scmContext   The scm context to which user belongs
     * @return {Promise}
     */
    async _getFile({ scmUri, path, token, ref }) {
        const { repoId, branch, rootDir } = getScmUriParts(scmUri);
        const fullPath = rootDir ? Path.join(rootDir, path) : path;

        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                 `/projects/${repoId}/repository/files/${encodeURIComponent(fullPath)}`,
            qs: {
                ref: ref || branch
            }
        }).then((response) => {
            checkResponseError(response, '_getFile');

            return new Buffer(response.body.content, response.body.encoding).toString();
        });
    }

    /**
     * Get the changed files from a Github event
     * @async  _getChangedFiles
     * @param  {Object}   config
     * @param  {String}   config.type      Can be 'pr' or 'repo'
     * @param  {Object}   [config.payload] The webhook payload received from the SCM service.
     * @param  {String}   config.token     Service token to authenticate with Github
     * @param  {String}   [config.scmUri]  The scmUri to get PR info of
     * @param  {Integer}  [config.prNum]   The PR number
     * @return {Promise}                   Resolves to an array of filenames of the changed files
     */
    async _getChangedFiles({ type, payload, token, scmUri, prNum }) {
        if (type === 'pr') {
            try {
                const { repoId } = getScmUriParts(scmUri);

                const files = await this.breaker.runCommand({
                    json: true,
                    method: 'GET',
                    auth: {
                        bearer: token
                    },
                    url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                         `/projects/${repoId}/merge_requests/${prNum}/changes`
                });

                return files.body.changes.map(file => file.new_path);
            } catch (err) {
                logger.error('Failed to getChangedFiles: ', err);

                return [];
            }
        }

        if (type === 'repo') {
            const options = { default: [] };
            const added = Hoek.reach(payload, ['commits', 0, 'added'], options);
            const modified = Hoek.reach(payload, ['commits', 0, 'modified'], options);
            const removed = Hoek.reach(payload, ['commits', 0, 'removed'], options);

            // Adding the arrays together and pruning duplicates
            return [...new Set([...added, ...modified, ...removed])];
        }

        return [];
    }

    /**
     * Resolve a pull request object based on the config
     * @async  _getPrInfo
     * @param  {Object}   config
     * @param  {Object}   [config.scmRepo]  The SCM repository to look up
     * @param  {String}   config.scmUri     The scmUri to get PR info of
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @param  {Integer}  config.prNum      The PR number used to fetch the PR
     * @return {Promise}
     */
    async _getPrInfo({ prNum, scmUri, token }) {
        const { repoId } = getScmUriParts(scmUri);

        return this.breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                 `/projects/${repoId}/merge_requests/${prNum}`
        }).then((pullRequestInfo) => {
            const prSource = pullRequestInfo.body.source_project_id ===
                pullRequestInfo.body.target_project_id ? 'branch' : 'fork';

            return {
                name: `PR-${pullRequestInfo.body.id}`,
                ref: `pull/${pullRequestInfo.body.id}/merge`,
                sha: pullRequestInfo.body.sha,
                prBranchName: pullRequestInfo.body.source_branch,
                url: pullRequestInfo.body.web_url,
                username: pullRequestInfo.body.author.username,
                title: pullRequestInfo.body.title,
                createTime: pullRequestInfo.body.created_at,
                userProfile: pullRequestInfo.body.author.web_url,
                baseBranch: pullRequestInfo.body.source_branch,
                mergeable: pullRequestInfo.body.user.can_merge,
                prSource
            };
        }).catch((err) => {
            logger.error('Failed to getPrInfo: ', err);
            throw err;
        });
    }

    /**
     * Return a valid Bell configuration (for OAuth)
     * @method _getBellConfiguration
     * @return {Promise}
     */
    async _getBellConfiguration() {
        const scmContexts = this._getScmContexts();
        const scmContext = scmContexts[0];
        const cookie = `gitlab-${this.config.gitlabHost}`;
        const bellConfig = {};

        bellConfig[scmContext] = {
            provider: 'gitlab',
            cookie,
            clientId: this.config.oauthClientId,
            clientSecret: this.config.oauthClientSecret,
            isSecure: this.config.https,
            forceHttps: this.config.https
        };

        if (this.config.gitlabHost) {
            bellConfig[scmContext].config = {
                uri: `${this.config.gitlabProtocol}://${this.config.gitlabHost}`
            };
        }

        return Promise.resolve(bellConfig);
    }

    /**
     * Get list of objects (each consists of opened PR name and ref (branch)) of a pipeline
     * @async getOpenedPRs
     * @param  {Object}   config              Configuration
     * @param  {String}   config.scmUri       The scmUri to get opened PRs
     * @param  {String}   config.token        The token used to authenticate to the SCM
     * @return {Promise}
     */
    async _getOpenedPRs({ scmUri, token }) {
        const repoInfo = getScmUriParts(scmUri);

        return this.breaker.runCommand({
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            },
            qs: {
                state: 'opened'
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v4` +
                 `/projects/${repoInfo.repoId}/merge_requests`
        }).then((response) => {
            checkResponseError(response, '_getOpenedPRs');

            const prList = response.body;

            return prList.map(pr => ({
                name: `PR-${pr.iid}`,
                ref: `merge_requests/${pr.iid}`,
                username: pr.author.username,
                title: pr.title,
                createTime: pr.created_at,
                url: pr.web_url,
                userProfile: pr.author.web_url
            }));
        });
    }

    /**
     * Retrieve stats for the executor
     * @method stats
     * @param  {Response} Object          Object containing stats for the executor
     */
    stats() {
        const stats = this.breaker.stats();
        const scmContexts = this._getScmContexts();
        const scmContext = scmContexts[0];

        return {
            [scmContext]: stats
        };
    }

    /**
     * Get an array of scm context (e.g. gitlab.com)
     * @method getScmContext
     * @return {Array}
     */
    _getScmContexts() {
        return this.config.gitlabHost
            ? [`gitlab:${this.config.gitlabHost}`]
            : ['gitlab:gitlab.com'];
    }

    /**
     * Determine if a scm module can handle the received webhook
     * @method canHandleWebhook
     * @param {Object}    headers    The request headers associated with the webhook payload
     * @param {Object}    payload    The webhook payload received from the SCM service
     * @return {Promise}
     */
    async _canHandleWebhook(headers, payload) {
        if (!Object.keys(headers).includes('x-gitlab-event')) {
            logger.error('Failed to run canHandleWebhook');

            return Promise.resolve(false);
        }

        try {
            const result = await this._parseHook(headers, payload);

            return result !== null;
        } catch (err) {
            logger.error('Failed to run canHandleWebhook', err);

            return false;
        }
    }

    /**
    * Gitlab doesn't have an equivalent endpoint to open pull request,
    * so returning null for now
    * @method _openPr
    * @param  {Object}     config                  Configuration
    * @param  {String}     config.checkoutUrl      Checkout url to the repo
    * @param  {String}     config.token            Service token to authenticate with the SCM service
    * @param  {String}     config.files            Files to open pull request with
    * @param  {String}     config.title            Pull request title
    * @param  {String}     config.message          Pull request message
    * @param  {String}     [config.scmContext]     The scm context name
    * @return {Promise}                            Resolves when operation completed without failure
    */
    async _openPr() {
        return Promise.resolve(null);
    }
}

module.exports = GitlabScm;
