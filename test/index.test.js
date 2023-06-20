'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');
const scmContext = 'gitlab:gitlab.com';
const scmUri = 'gitlab.com:repoId:branchName';
const testCommands = require('./data/commands.json');
const testPrCommands = require('./data/prCommands.json');
const testPrComment = require('./data/gitlab.merge_request.comment.json');
const testPrComments = require('./data/gitlab.merge_request.comments.json');
const testCustomPrCommands = require('./data/customPrCommands.json');
const testRootDirCommands = require('./data/rootDirCommands.json');
const testChildCommands = require('./data/childCommands.json');
const testPayloadOpen = require('./data/gitlab.merge_request.opened.json');
const testPayloadClose = require('./data/gitlab.merge_request.closed.json');
const testPayloadPush = require('./data/gitlab.push.json');
const testCommit = require('./data/gitlab.commit.json');
const testChangedFiles = require('./data/gitlab.merge_request.changedFiles.json');
const testMergeRequest = require('./data/gitlab.merge_request.json');
const testWebhookConfigOpen = require('./data/webhookConfig.merge_request.opened.json');
const testWebhookConfigPushBadHead = require('./data/webhookConfig.push.bad.json');
const testWebhookConfigPush = require('./data/webhookConfig.push.json');
const token = 'myAccessToken';
const commentUserToken = 'commentUserToken';
const prefixUrl = 'https://gitlab.com/api/v4';

sinon.assert.expose(assert, { prefix: '' });

describe('index', function () {
    // Time not important. Only life important.
    this.timeout(5000);

    let GitlabScm;
    let scm;
    let requestMock;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        requestMock = sinon.stub();
        mockery.registerMock('screwdriver-request', requestMock);

        /* eslint-disable global-require */
        GitlabScm = require('../index');
        /* eslint-enable global-require */

        scm = new GitlabScm({
            fusebox: {
                retry: {
                    minTimeout: 1
                }
            },
            oauthClientId: 'myclientid',
            oauthClientSecret: 'myclientsecret',
            commentUserToken
        });
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    describe('constructor', () => {
        it('validates input', () => {
            try {
                scm = new GitlabScm();
                assert.fail('should not get here');
            } catch (err) {
                assert.instanceOf(err, Error);
                assert.equal(err.name, 'ValidationError');
            }
        });
        it('constructs successfully', () => {
            const testScm = new GitlabScm({
                oauthClientId: 'myclientid',
                oauthClientSecret: 'myclientsecret',
                username: 'abcd',
                email: 'dev-null@my.email.com'
            });

            assert.deepEqual(testScm.config, {
                oauthClientId: 'myclientid',
                oauthClientSecret: 'myclientsecret',
                username: 'abcd',
                email: 'dev-null@my.email.com',
                gitlabHost: 'gitlab.com',
                gitlabProtocol: 'https',
                fusebox: {},
                readOnly: {},
                https: false
            });
        });
    });

    describe('parseUrl', () => {
        const apiUrl = 'projects/batman%2Ftest';
        let fakeResponse;
        let expectedOptions;
        let expected;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    id: '12345',
                    default_branch: 'main'
                }
            };
            expectedOptions = {
                url: `${prefixUrl}/${apiUrl}`,
                method: 'GET',
                context: {
                    token
                }
            };
            expected = 'gitlab.com:12345:master';
            requestMock.resolves(fakeResponse);
        });

        it('resolves to the correct parsed url for ssh', () =>
            scm
                .parseUrl({
                    checkoutUrl: 'git@gitlab.com:batman/test.git#master',
                    token,
                    scmContext
                })
                .then(parsed => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(parsed, expected);
                }));

        it('resolves to the correct parsed url for ssh with default branch', () => {
            expected = 'gitlab.com:12345:main';

            return scm
                .parseUrl({
                    checkoutUrl: 'git@gitlab.com:batman/test.git',
                    token,
                    scmContext
                })
                .then(parsed => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(parsed, expected);
                });
        });

        it('resolves to the correct parsed url for rootDir', () => {
            expected = 'gitlab.com:12345:branch:path/to/source';

            return scm
                .parseUrl({
                    checkoutUrl: 'git@gitlab.com:batman/test.git#branch:path/to/source',
                    token,
                    scmContext
                })
                .then(parsed => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(parsed, expected);
                });
        });

        it('resolves to the correct parsed url for https', () => {
            expected = 'gitlab.com:12345:mynewbranch';

            return scm
                .parseUrl({
                    checkoutUrl: 'https://batman@gitlab.com/batman/test.git#mynewbranch',
                    token,
                    scmContext
                })
                .then(parsed => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(parsed, expected);
                });
        });

        it('rejects if request fails', () => {
            const err = new Error('Gitlab API error');

            requestMock.rejects(err);

            return scm
                .parseUrl({
                    checkoutUrl: 'https://batman@gitlab.com/batman/test.git#mynewbranch',
                    token,
                    scmContext
                })
                .then(() => assert.fail('Should not get here'))
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(error, err);
                });
        });

        it('rejects if status code is 404', () => {
            const err = new Error('404 Reason "404 Project Not Found" Caller "_parseUrl"');

            err.status = 404;

            requestMock.rejects(err);

            return scm
                .parseUrl({
                    checkoutUrl: 'https://batman@gitlab.com/batman/test.git#mynewbranch',
                    token,
                    scmContext
                })
                .then(() => assert.fail('Should not get here'))
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, '404 Reason "404 Project Not Found" Caller "_parseUrl"');
                    assert.match(error.status, 404);
                });
        });

        it('rejects if status code is not 200 & 404', () => {
            const err = new Error('500 Reason "Internal Server Error" Caller "_parseUrl"');

            err.status = 500;

            requestMock.rejects(err);

            return scm
                .parseUrl({
                    checkoutUrl: 'https://batman@gitlab.com/batman/test.git#mynewbranch',
                    token,
                    scmContext
                })
                .then(() => assert.fail('Should not get here'))
                .catch(error => {
                    assert.match(error.message, '500 Reason "Internal Server Error" Caller "_parseUrl"');
                    assert.match(error.status, 500);
                });
        });

        it('rejects when passed checkoutUrl of another host', () => {
            const expectedError = 'This checkoutUrl is not supported for your current login host.';

            return scm
                .parseUrl({
                    checkoutUrl: 'git@gitlab.corp.jp:batman/test.git#master',
                    scmContext,
                    token
                })
                .then(
                    () => {
                        assert.fail('Should not get here');
                    },
                    error => {
                        assert.match(error.message, expectedError);
                        assert.match(error.statusCode, 400);
                    }
                );
        });
    });

    describe('parseHook', () => {
        const checkoutUrl = 'git@example.com:bdangit/quickstart-generic.git';

        it('resolves the correct parsed config for opened PR', () => {
            const expected = {
                type: 'pr',
                action: 'opened',
                username: 'bdangit',
                checkoutUrl,
                branch: 'master',
                sha: '249b26f2278c39f9efc55986f845dd98ae011763',
                prNum: 6,
                prRef: 'merge_requests/6',
                prSource: 'branch',
                prTitle: 'fix tabby cat',
                ref: 'pull/6/merge',
                hookId: '',
                scmContext
            };
            const headers = {
                'content-type': 'application/json',
                'x-gitlab-event': 'Merge Request Hook'
            };

            return scm.parseHook(headers, testPayloadOpen).then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for closed PR after merged', () => {
            const expected = {
                type: 'pr',
                action: 'closed',
                username: 'bdangit',
                checkoutUrl,
                branch: 'master',
                sha: 'bc2b3a48a428ed23e15960e8d703bf7e3a8a4f54',
                prNum: 2,
                prRef: 'merge_requests/2',
                prSource: 'branch',
                prTitle: 'Fix this stuff',
                ref: 'pull/2/merge',
                hookId: '',
                scmContext
            };
            const headers = {
                'content-type': 'application/json',
                'x-gitlab-event': 'Merge Request Hook'
            };

            return scm.parseHook(headers, testPayloadClose).then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for closed PR after declined', () => {
            const expected = {
                type: 'pr',
                action: 'closed',
                username: 'bdangit',
                checkoutUrl,
                branch: 'master',
                sha: 'bc2b3a48a428ed23e15960e8d703bf7e3a8a4f54',
                prNum: 2,
                prRef: 'merge_requests/2',
                prSource: 'branch',
                prTitle: 'Fix this stuff',
                ref: 'pull/2/merge',
                hookId: '',
                scmContext
            };
            const headers = {
                'content-type': 'application/json',
                'x-gitlab-event': 'Merge Request Hook'
            };

            return scm.parseHook(headers, testPayloadClose).then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for push to repo event', () => {
            const expected = {
                type: 'repo',
                action: 'push',
                username: 'jsmith',
                checkoutUrl: 'git@example.com:mike/diaspora.git',
                commitAuthors: ['Jordi Mallach', 'GitLab dev user'],
                branch: 'master',
                lastCommitMessage: 'fixed readme',
                ref: 'refs/heads/master',
                sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
                hookId: '',
                scmContext,
                addedFiles: ['CHANGELOG'],
                modifiedFiles: ['app/controller/application.rb'],
                removedFiles: []
            };
            const headers = {
                'content-type': 'application/json',
                'x-gitlab-event': 'Push Hook'
            };

            return scm.parseHook(headers, testPayloadPush).then(result => assert.deepEqual(result, expected));
        });

        it('resolves null if events are not supported: repoFork', () => {
            const repoFork = {
                'x-event-key': 'repo:fork'
            };

            return scm.parseHook(repoFork, {}).then(result => assert.deepEqual(result, null));
        });

        it('resolves null if events are not supported: prComment', () => {
            const prComment = {
                'x-event-key': 'pullrequest:comment_created'
            };

            return scm.parseHook(prComment, {}).then(result => assert.deepEqual(result, null));
        });

        it('resolves null if events are not supported: issueCreated', () => {
            const issueCreated = {
                'x-event-key': 'issue:created'
            };

            return scm.parseHook(issueCreated, {}).then(result => assert.deepEqual(result, null));
        });

        it('resolves null for a pull request payload with an unsupported action', () => {
            const testHeaders = {
                'x-gitlab-event': 'Push Hook',
                action: 'locked'
            };

            return scm.parseHook(testHeaders, { object_kind: 'merge_request' }).then(result => assert.isNull(result));
        });
    });

    describe('decorateAuthor', () => {
        const apiUrl = 'users';
        const expectedOptions = {
            url: `${prefixUrl}/${apiUrl}`,
            method: 'GET',
            context: {
                token
            },
            searchParams: {
                username: 'batman'
            }
        };
        let fakeResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: [
                    {
                        username: 'batman',
                        name: 'Batman',
                        id: 12345,
                        state: 'active',
                        avatar_url: 'https://gitlab.com/uploads/user/avatar/12345/avatar.png',
                        web_url: 'https://gitlab.com/batman'
                    }
                ]
            };
            requestMock.resolves(fakeResponse);
        });

        it('resolves to correct decorated author', () => {
            const expected = {
                id: 12345,
                url: 'https://gitlab.com/batman',
                name: 'Batman',
                username: 'batman',
                avatar: 'https://gitlab.com/uploads/user/avatar/12345/avatar.png'
            };

            return scm
                .decorateAuthor({
                    username: 'batman',
                    scmContext,
                    token
                })
                .then(decorated => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(decorated, expected);
                });
        });

        it('rejects if status code is not 200', () => {
            const err = new Error('404 Reason "Resource not found" Caller "_decorateAuthor"');

            err.status = 404;

            requestMock.rejects(err);

            return scm
                .decorateAuthor({
                    username: 'batman',
                    scmContext,
                    token
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, '404 Reason "Resource not found" Caller "_decorateAuthor"');
                    assert.match(error.status, 404);
                });
        });

        it('rejects if fails', () => {
            const err = new Error('500 Reason "Internal Server Error" Caller "_decorateAuthor"');

            err.status = 500;

            requestMock.rejects(err);

            return scm
                .decorateAuthor({
                    username: 'batman',
                    scmContext,
                    token
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.equal(error, err);
                });
        });
    });

    describe('decorateUrl', () => {
        const apiUrl = 'projects/repoId';
        let fakeResponse;
        let expectedOptions;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    path_with_namespace: 'username/repoName'
                }
            };
            expectedOptions = {
                url: `${prefixUrl}/${apiUrl}`,
                method: 'GET',
                context: {
                    token
                }
            };
            requestMock.resolves(fakeResponse);
        });

        it('resolves to correct decorated url object', () => {
            const expected = {
                url: 'https://gitlab.com/username/repoName/-/tree/branchName',
                name: 'username/repoName',
                branch: 'branchName',
                rootDir: ''
            };

            return scm
                .decorateUrl({
                    scmUri,
                    token,
                    scmContext
                })
                .then(decorated => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(decorated, expected);
                });
        });

        it('resolves to correct decorated url object with rootDir', () => {
            const expected = {
                url: 'https://gitlab.com/username/repoName/-/tree/branchName/path/to/source',
                name: 'username/repoName',
                branch: 'branchName',
                rootDir: 'path/to/source'
            };

            return scm
                .decorateUrl({
                    scmUri: 'gitlab.com:repoId:branchName:path/to/source',
                    token,
                    scmContext
                })
                .then(decorated => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(decorated, expected);
                });
        });

        it('rejects if status code is not 200', () => {
            const err = new Error('404 Reason "Resource not found" Caller "lookupScmUri"');

            err.status = 404;

            requestMock.rejects(err);

            return scm
                .decorateUrl({
                    scmUri,
                    token,
                    scmContext
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, '404 Reason "Resource not found" Caller "lookupScmUri"');
                    assert.match(error.status, 404);
                });
        });

        it('rejects when scm settings is mismatch', () => {
            const scmUriNotMatch = 'notMatching.com:repoId:branchName';
            const [scmHost] = scmUriNotMatch.split(':');
            const loginContext = scm.getScmContexts();
            const loginHost = loginContext[0].split(':')[1];

            return scm
                .decorateUrl({
                    scmUri: scmUriNotMatch,
                    token,
                    scmContext
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.match(
                        error.message,
                        `Pipeline's scmHost ${scmHost} does not match with user's scmHost ${loginHost}`
                    );
                });
        });

        it('rejects if fails', () => {
            const err = new Error('Gitlab API error');

            err.status = 500;

            requestMock.rejects(err);

            return scm
                .decorateUrl({
                    scmUri,
                    token,
                    scmContext
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.called(requestMock);
                    assert.equal(error, err);
                });
        });
    });

    describe('decorateCommit', () => {
        const sha = '1111111111111111111111111111111111111111';
        const lookupScmUriRoute = 'projects/repoId';
        const commitLookupRoute = `projects/owner%2FrepoName/repository/commits/${sha}`;
        let lookupScmUri;
        let lookupScmUriResponse;
        let commitLookup;
        let commitLookupResponse;

        beforeEach(() => {
            lookupScmUri = {
                url: `${prefixUrl}/${lookupScmUriRoute}`,
                method: 'GET',
                context: {
                    token
                }
            };
            lookupScmUriResponse = {
                statusCode: 200,
                body: {
                    path_with_namespace: 'owner/repoName'
                }
            };
            commitLookup = {
                url: `${prefixUrl}/${commitLookupRoute}`,
                method: 'GET',
                context: {
                    token
                }
            };
            commitLookupResponse = {
                statusCode: 200,
                body: testCommit
            };

            requestMock.onFirstCall().resolves(lookupScmUriResponse);
            requestMock.onSecondCall().resolves(commitLookupResponse);
        });

        it('resolves to correct decorated object', () => {
            const expected = {
                author: {
                    url: 'https://cd.screwdriver.cd/',
                    name: 'randx',
                    username: 'n/a',
                    avatar: 'https://cd.screwdriver.cd/assets/unknown_user.png'
                },
                committer: {
                    avatar: 'https://cd.screwdriver.cd/assets/unknown_user.png',
                    name: 'Dmitriy',
                    url: 'https://cd.screwdriver.cd/',
                    username: 'n/a'
                },
                message: 'Sanitize for network graph',
                // eslint-disable-next-line
                url: 'https://gitlab.example.com/thedude/gitlab-foss/-/commit/6104942438c14ec7bd21c6cd5bd995272b3faff6'
            };

            return scm
                .decorateCommit({
                    sha,
                    scmUri,
                    token,
                    scmContext
                })
                .then(decorated => {
                    assert.calledWith(requestMock.firstCall, lookupScmUri);
                    assert.calledWith(requestMock.secondCall, commitLookup);
                    assert.calledTwice(requestMock);
                    assert.deepEqual(decorated, expected);
                });
        });

        it('rejects if status code is not 200', () => {
            const err = new Error('404 Reason "Resource not found" Caller "_decorateCommit: commitLookup"');

            err.status = 404;

            requestMock.onFirstCall().resolves(lookupScmUriResponse);
            requestMock.onSecondCall().rejects(err);

            return scm
                .decorateCommit({
                    sha,
                    scmUri,
                    token,
                    scmContext
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    // assert.calledTwice(requestMock);
                    assert.match(
                        error.message,
                        '404 Reason "Resource not found" Caller "_decorateCommit: commitLookup"'
                    );
                    assert.match(error.status, 404);
                });
        });
    });

    describe('getCommitSha', () => {
        const apiUrl = 'projects/repoId/repository/branches/branchName';
        const expectedOptions = {
            url: `${prefixUrl}/${apiUrl}`,
            method: 'GET',
            context: {
                token
            }
        };
        let fakeResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    commit: {
                        id: 'hashValue'
                    }
                }
            };
            requestMock.resolves(fakeResponse);
        });

        it('resolves to correct commit sha', () =>
            scm
                .getCommitSha({
                    scmUri,
                    token,
                    scmContext
                })
                .then(sha => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(sha, 'hashValue');
                }));

        it('rejects if status code is not 200', () => {
            const err = new Error('404 Reason "Resource not found" Caller "_getCommitSha"');

            err.status = 404;

            requestMock.rejects(err);

            return scm
                .getCommitSha({
                    scmUri,
                    token,
                    scmContext
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, '404 Reason "Resource not found" Caller "_getCommitSha"');
                    assert.match(error.status, 404);
                });
        });

        it('rejects if fails', () => {
            const err = new Error('Gitlab API error');

            requestMock.rejects(err);

            return scm
                .getCommitSha({
                    scmUri,
                    token,
                    scmContext
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(error, err);
                });
        });
    });

    describe('addPrComment', () => {
        const apiUrl = 'projects/repoId/merge_requests/12345/notes';
        const comments = [{ text: 'this was a great PR' }];
        const prNum = 12345;
        const jobName = 'main';
        const pipelineId = 123456;
        const expectedOptions = {
            url: `${prefixUrl}/${apiUrl}`,
            method: 'POST',
            context: {
                token: commentUserToken
            },
            json: {
                body: comments[0].text
            }
        };
        let fakeResponse;
        let fakeCommentsResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: testPrComment
            };
            fakeCommentsResponse = {
                statusCode: 200,
                body: testPrComments
            };
            requestMock.onFirstCall().resolves({
                statusCode: 200,
                body: []
            });
            requestMock.onSecondCall().resolves(fakeResponse);
        });

        it('resolves to correct PR metadata', () =>
            scm
                .addPrComment({
                    comments,
                    jobName,
                    prNum,
                    scmUri,
                    token,
                    pipelineId,
                    scmContext
                })
                .then(result => {
                    assert.calledTwice(requestMock);
                    assert.calledWith(requestMock.secondCall, expectedOptions);
                    assert.deepEqual(result, [
                        {
                            commentId: 126861726,
                            createTime: '2018-12-21T20:33:33.157Z',
                            username: 'tkyi'
                        }
                    ]);
                }));

        it('resolves to correct PR metadata for edited comment', () => {
            requestMock.onFirstCall().resolves(fakeCommentsResponse);
            requestMock.onSecondCall().resolves(fakeResponse);

            return scm
                .addPrComment({
                    comments,
                    jobName,
                    prNum,
                    scmUri,
                    token,
                    pipelineId,
                    scmContext
                })
                .then(result => {
                    assert.calledTwice(requestMock);
                    assert.calledWith(requestMock.firstCall, {
                        url: `${prefixUrl}/${apiUrl}`,
                        method: 'GET',
                        context: {
                            token: commentUserToken
                        }
                    });
                    assert.calledWith(requestMock.secondCall, {
                        url: `${prefixUrl}/${apiUrl}/575335839`,
                        method: 'PUT',
                        context: {
                            token: commentUserToken
                        },
                        json: {
                            body: 'this was a great PR'
                        }
                    });
                    assert.deepEqual(result, [
                        {
                            commentId: 126861726,
                            createTime: '2018-12-21T20:33:33.157Z',
                            username: 'tkyi'
                        }
                    ]);
                });
        });

        it('creats multiple comments', () => {
            const multipleComments = [
                { text: 'this was a great PR', keyword: 'foos' },
                { text: 'this was not a great PR', keyword: 'bars' }
            ];

            requestMock.onFirstCall().resolves(fakeCommentsResponse);
            requestMock.onSecondCall().resolves(fakeResponse);
            requestMock.onThirdCall().resolves(fakeResponse);

            return scm
                .addPrComment({
                    comments: multipleComments,
                    jobName,
                    prNum,
                    scmUri,
                    token,
                    pipelineId,
                    scmContext
                })
                .then(result => {
                    assert.calledWith(requestMock.firstCall, {
                        url: `${prefixUrl}/${apiUrl}`,
                        method: 'GET',
                        context: {
                            token: commentUserToken
                        }
                    });
                    assert.calledWith(requestMock.secondCall, {
                        url: `${prefixUrl}/${apiUrl}`,
                        method: 'POST',
                        context: {
                            token: commentUserToken
                        },
                        json: {
                            body: 'this was a great PR'
                        }
                    });
                    assert.calledWith(requestMock.thirdCall, {
                        url: `${prefixUrl}/${apiUrl}`,
                        method: 'POST',
                        context: {
                            token: commentUserToken
                        },
                        json: {
                            body: 'this was not a great PR'
                        }
                    });
                    assert.deepEqual(result, [
                        {
                            commentId: 126861726,
                            createTime: '2018-12-21T20:33:33.157Z',
                            username: 'tkyi'
                        },
                        {
                            commentId: 126861726,
                            createTime: '2018-12-21T20:33:33.157Z',
                            username: 'tkyi'
                        }
                    ]);
                });
        });

        it('edits multiple comments', () => {
            const multipleComments = [
                { text: 'this was a great PR', keyword: 'foo' },
                { text: 'this was not a great PR', keyword: 'bar' }
            ];

            requestMock.onFirstCall().resolves(fakeCommentsResponse);
            requestMock.onSecondCall().resolves(fakeResponse);
            requestMock.onThirdCall().resolves(fakeResponse);

            return scm
                .addPrComment({
                    comments: multipleComments,
                    jobName,
                    prNum,
                    scmUri,
                    token,
                    pipelineId,
                    scmContext
                })
                .then(result => {
                    assert.calledWith(requestMock.firstCall, {
                        url: `${prefixUrl}/${apiUrl}`,
                        method: 'GET',
                        context: {
                            token: commentUserToken
                        }
                    });
                    assert.calledWith(requestMock.secondCall, {
                        url: `${prefixUrl}/${apiUrl}/575311268`,
                        method: 'PUT',
                        context: {
                            token: commentUserToken
                        },
                        json: {
                            body: 'this was a great PR'
                        }
                    });
                    assert.calledWithMatch(requestMock, {
                        url: `${prefixUrl}/${apiUrl}/575335839`,
                        method: 'PUT',
                        context: {
                            token: commentUserToken
                        },
                        json: {
                            body: 'this was not a great PR'
                        }
                    });
                    assert.deepEqual(result, [
                        {
                            commentId: 126861726,
                            createTime: '2018-12-21T20:33:33.157Z',
                            username: 'tkyi'
                        },
                        {
                            commentId: 126861726,
                            createTime: '2018-12-21T20:33:33.157Z',
                            username: 'tkyi'
                        }
                    ]);
                });
        });

        it('resolves empty array if status code is not 200', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    message: 'Resource not found'
                }
            };
            requestMock.onSecondCall().resolves(fakeResponse);

            return scm
                .addPrComment({
                    comments,
                    jobName,
                    prNum,
                    scmUri,
                    token,
                    pipelineId,
                    scmContext
                })
                .then(data => {
                    assert.isEmpty(data);
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, '404 Reason "Resource not found" Caller "_addPrComment"');
                    assert.match(error.status, 404);
                });
        });

        it('resolves empty array if status code is not 200 for edited comment', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    message: 'Resource not found'
                }
            };
            requestMock.onFirstCall().resolves(fakeCommentsResponse, fakeCommentsResponse.body);
            requestMock.onSecondCall().resolves(fakeResponse);

            return scm
                .addPrComment({
                    comments,
                    jobName,
                    prNum,
                    scmUri,
                    token,
                    pipelineId,
                    scmContext
                })
                .then(data => {
                    assert.isEmpty(data);
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, '404 Reason "Resource not found" Caller "_addPrComment"');
                    assert.match(error.status, 404);
                });
        });
    });

    describe('getFile', () => {
        const apiUrl = 'projects/repoId/repository/files/path%2Fto%2Ffile.txt';
        let expectedOptions;
        let fakeResponse;
        let params;

        beforeEach(() => {
            expectedOptions = {
                url: `${prefixUrl}/${apiUrl}`,
                method: 'GET',
                context: {
                    token
                },
                searchParams: {
                    ref: 'branchName'
                }
            };
            fakeResponse = {
                statusCode: 200,
                body: {
                    encoding: 'ascii',
                    content: 'dataValue'
                }
            };
            params = {
                scmUri,
                scmContext,
                token,
                path: 'path/to/file.txt'
            };
            requestMock.resolves(fakeResponse);
        });

        it('resolves to correct commit sha', () =>
            scm.getFile(params).then(content => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(content, 'dataValue');
            }));

        it('resolves to correct commit sha when rootDir is passed in', () => {
            params.scmUri = 'hostName:repoId:branchName:path/to/source';
            expectedOptions.url = `${prefixUrl}/projects/repoId/repository/files/path%2Fto%2Fsource%2Fpath%2Fto%2Ffile.txt`;

            return scm.getFile(params).then(content => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(content, 'dataValue');
            });
        });

        it('resolves to correct commit sha when only full path is passed', () =>
            scm
                .getFile({
                    scmUri: 'gitlab.com:146:master:src/app/component',
                    path: 'https://ossmirror.vzbuilders.com/screwdriver-cd/scm-gitlab.git#master:path/to/a/file.yaml',
                    token: 'somerandomtoken'
                })
                .then(content => {
                    assert.deepEqual(content, 'dataValue');
                    assert.calledWith(requestMock, {
                        method: 'GET',
                        searchParams: { ref: 'master' },
                        url: 'https://gitlab.com/api/v4/projects/screwdriver-cd%2Fscm-gitlab/repository/files/path%2Fto%2Fa%2Ffile.yaml',
                        context: { token: 'somerandomtoken' }
                    });
                }));

        it('rejects if status code is not 200', () => {
            const err = new Error('404 Reason "Resource not found" Caller "_getFile"');

            err.status = 404;

            requestMock.rejects(err);

            return scm
                .getFile(params)
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, '404 Reason "Resource not found" Caller "_getFile"');
                    assert.match(error.status, 404);
                });
        });

        it('rejects if fails', () => {
            const err = new Error('Gitlab API error');

            requestMock.rejects(err);

            return scm
                .getFile(params)
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(error, err);
                });
        });
    });

    describe('getPermissions', () => {
        const apiUrl = 'projects/repoId';
        let expectedOptions;
        let fakeResponse;

        beforeEach(() => {
            expectedOptions = {
                url: `${prefixUrl}/${apiUrl}`,
                method: 'GET',
                context: {
                    token
                }
            };

            fakeResponse = {
                statusCode: 200,
                body: {
                    permissions: {
                        project_access: {
                            access_level: 50
                        }
                    }
                }
            };

            requestMock.resolves(fakeResponse);
        });

        it('get correct permissions for level 50', () =>
            scm
                .getPermissions({
                    scmUri,
                    token,
                    scmContext
                })
                .then(permissions => {
                    assert.calledOnce(requestMock);
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(permissions, {
                        admin: true,
                        push: true,
                        pull: true
                    });
                }));

        it('get correct permissions for level 40', () => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    permissions: {
                        project_access: {
                            access_level: 40
                        }
                    }
                }
            };

            requestMock.resolves(fakeResponse);

            return scm
                .getPermissions({
                    scmUri,
                    token,
                    scmContext
                })
                .then(permissions => {
                    assert.calledOnce(requestMock);
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(permissions, {
                        admin: true,
                        push: true,
                        pull: true
                    });
                });
        });

        it('get correct permissions for level 30', () => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    permissions: {
                        project_access: {
                            access_level: 30
                        }
                    }
                }
            };

            requestMock.resolves(fakeResponse);

            return scm
                .getPermissions({
                    scmUri,
                    token,
                    scmContext
                })
                .then(permissions => {
                    assert.calledOnce(requestMock);
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(permissions, {
                        admin: false,
                        push: true,
                        pull: true
                    });
                });
        });

        it('get correct permissions for level 20', () => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    permissions: {
                        project_access: {
                            access_level: 20
                        }
                    }
                }
            };

            requestMock.resolves(fakeResponse);

            return scm
                .getPermissions({
                    scmUri,
                    token,
                    scmContext
                })
                .then(permissions => {
                    assert.calledOnce(requestMock);
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(permissions, {
                        admin: false,
                        push: false,
                        pull: true
                    });
                });
        });

        it('get correct permissions for level 10', () => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    permissions: {
                        project_access: {
                            access_level: 10
                        }
                    }
                }
            };

            requestMock.resolves(fakeResponse);

            return scm
                .getPermissions({
                    scmUri,
                    token,
                    scmContext
                })
                .then(permissions => {
                    assert.calledOnce(requestMock);
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(permissions, {
                        admin: false,
                        push: false,
                        pull: false
                    });
                });
        });

        it('get correct permissions for level 90', () => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    permissions: {
                        project_access: {
                            access_level: 90
                        }
                    }
                }
            };

            requestMock.resolves(fakeResponse);

            return scm
                .getPermissions({
                    scmUri,
                    token,
                    scmContext
                })
                .then(permissions => {
                    assert.calledOnce(requestMock);
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(permissions, {
                        admin: false,
                        push: false,
                        pull: false
                    });
                });
        });

        it('get correct permissions when no access_level is present', () => {
            fakeResponse = {
                statusCode: 200,
                body: {}
            };

            requestMock.resolves(fakeResponse);

            return scm
                .getPermissions({
                    scmUri,
                    token,
                    scmContext
                })
                .then(permissions => {
                    assert.calledOnce(requestMock);
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(permissions, {
                        admin: false,
                        push: false,
                        pull: false
                    });
                });
        });

        it('rejects if status code is not 200', () => {
            const err = new Error('404 Reason "Resource not found" Caller "_getPermissions"');

            err.status = 404;

            requestMock.rejects(err);

            return scm
                .getPermissions({
                    scmUri,
                    token,
                    scmContext
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.match(error.message, '404 Reason "Resource not found" Caller "_getPermissions"');
                    assert.match(error.status, 404);
                });
        });

        it('rejects if fails', () => {
            const error = new Error('Gitlab API error');

            requestMock.rejects(error);

            return scm
                .getPermissions({
                    scmUri,
                    token,
                    scmContext
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(err => {
                    assert.equal(error, err);
                });
        });
    });

    describe('updateCommitStatus', () => {
        let config;
        let apiUrl;
        let fakeResponse;
        let expectedOptions;

        beforeEach(() => {
            config = {
                scmUri,
                scmContext,
                sha: '1111111111111111111111111111111111111111',
                buildStatus: 'SUCCESS',
                token,
                url: 'http://valid.url',
                jobName: 'main',
                pipelineId: 675
            };
            apiUrl = `projects/repoId/statuses/${config.sha}`;
            fakeResponse = {
                statusCode: 201
            };
            expectedOptions = {
                url: `${prefixUrl}/${apiUrl}`,
                method: 'POST',
                context: {
                    token
                },
                json: {
                    context: 'Screwdriver/675/main',
                    target_url: config.url,
                    state: 'success',
                    description: 'Everything looks good!'
                }
            };
            requestMock.resolves(fakeResponse);
        });

        it('successfully update status', () =>
            scm.updateCommitStatus(config).then(() => {
                assert.calledWith(requestMock, expectedOptions);
            }));

        it('successfully update status with correct values', () => {
            config.buildStatus = 'FAILURE';
            expectedOptions.json.context = 'Screwdriver/675/main';
            expectedOptions.json.state = 'failed';
            expectedOptions.json.description = 'Did not work as expected.';

            return scm.updateCommitStatus(config).then(() => {
                assert.calledWith(requestMock, expectedOptions);
            });
        });

        it('rejects if status code is not 201 or 200', () => {
            const err = new Error('401 Reason "Access token expired" Caller "_updateCommitStatus"');

            err.status = 401;

            requestMock.rejects(err);

            return scm
                .updateCommitStatus(config)
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, '401 Reason "Access token expired" Caller "_updateCommitStatus"');
                    assert.match(error.status, 401);
                });
        });

        it('rejects if fails', () => {
            const err = new Error('Gitlab API error');

            requestMock.rejects(err);

            return scm
                .updateCommitStatus(config)
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(error, err);
                });
        });
    });

    describe('getBellConfiguration', () => {
        it('resolves a default configuration', () =>
            scm.getBellConfiguration().then(config => {
                assert.deepEqual(config, {
                    'gitlab:gitlab.com': {
                        clientId: 'myclientid',
                        clientSecret: 'myclientsecret',
                        config: {
                            uri: 'https://gitlab.com'
                        },
                        forceHttps: false,
                        isSecure: false,
                        provider: 'gitlab',
                        cookie: 'gitlab-gitlab.com'
                    }
                });
            }));

        it('resolves a configuration for gitlabHost chenged from default', () => {
            scm = new GitlabScm({
                oauthClientId: 'abcdef',
                oauthClientSecret: 'hijklm',
                gitlabHost: 'mygitlab.com'
            });

            const expected = {
                'gitlab:mygitlab.com': {
                    clientId: 'abcdef',
                    clientSecret: 'hijklm',
                    config: {
                        uri: 'https://mygitlab.com'
                    },
                    forceHttps: false,
                    isSecure: false,
                    provider: 'gitlab',
                    cookie: 'gitlab-mygitlab.com'
                }
            };

            return scm.getBellConfiguration().then(config => {
                assert.deepEqual(config, expected);
            });
        });
    });

    describe('getChangedFiles', () => {
        const apiUrl = 'projects/28476/merge_requests/1/changes';
        let type;
        let expectedOptions;
        let fakeResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: testChangedFiles
            };
            expectedOptions = {
                url: `${prefixUrl}/${apiUrl}`,
                method: 'GET',
                context: {
                    token
                }
            };
            requestMock.resolves(fakeResponse);
        });

        it('returns changed files for a push event payload', () => {
            type = 'repo';

            return scm
                .getChangedFiles({
                    type,
                    token,
                    webhookConfig: testWebhookConfigPush
                })
                .then(result => {
                    assert.deepEqual(result, ['CHANGELOG', 'app/controller/application.rb']);
                });
        });

        it('returns changed files for any given pr', () =>
            scm
                .getChangedFiles({
                    type: 'pr',
                    token,
                    webhookConfig: null,
                    scmUri: 'gitlab.com:28476:master',
                    prNum: 1
                })
                .then(result => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(result, ['test/screwdriver.yaml', 'README.md', 'screwdriver.yaml']);
                }));

        it('returns empty array for an event payload that is not type repo or pr', () => {
            type = 'ping';

            return scm
                .getChangedFiles({
                    type,
                    token,
                    webhookConfig: testWebhookConfigOpen
                })
                .then(result => {
                    assert.deepEqual(result, []);
                });
        });

        it('returns empty array for an event payload which does not have changed files', () => {
            type = 'repo';

            return scm
                .getChangedFiles({
                    type,
                    token,
                    webhookConfig: testWebhookConfigPushBadHead
                })
                .then(result => {
                    assert.deepEqual(result, []);
                });
        });
    });

    describe('getPrInfo', () => {
        const apiUrl = 'projects/repoId/merge_requests/1';
        const config = {
            scmUri,
            token,
            prNum: 1
        };
        const sha = '8888888888888888888888888888888888888888';
        let expectedOptions;
        let fakeResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: testMergeRequest
            };
            expectedOptions = {
                url: `${prefixUrl}/${apiUrl}`,
                method: 'GET',
                context: {
                    token
                }
            };
            requestMock.resolves(fakeResponse);
        });

        it('returns a pull request with the given prNum', () =>
            scm._getPrInfo(config).then(data => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(data, {
                    name: 'PR-1',
                    ref: 'pull/1/merge',
                    sha,
                    url: 'http://gitlab.example.com/my-group/my-project/merge_requests/1',
                    username: 'admin',
                    title: 'test1',
                    createTime: '2017-04-29T08:46:00Z',
                    userProfile: 'https://gitlab.example.com/admin',
                    prBranchName: 'test1',
                    baseBranch: 'test1',
                    mergeable: false,
                    prSource: 'fork'
                });
            }));

        it('rejects when failing to lookup the SCM URI information', () => {
            const testError = new Error('testError');

            requestMock.rejects(testError);

            return scm._getPrInfo(config).then(assert.fail, err => {
                assert.instanceOf(err, Error);
                assert.strictEqual(testError.message, err.message);
            });
        });
    });

    describe('getCheckoutCommand', () => {
        let config;

        beforeEach(() => {
            config = {
                branch: 'branchName',
                host: 'hostName',
                org: 'orgName',
                repo: 'repoName',
                sha: 'shaValue',
                scmContext
            };
        });

        it('resolves checkout command without prRef', () =>
            scm.getCheckoutCommand(config).then(command => {
                assert.deepEqual(command, testCommands);
            }));

        it('resolves checkout command with prRef', () => {
            config.prRef = 'prBranch';

            return scm.getCheckoutCommand(config).then(command => {
                assert.deepEqual(command, testPrCommands);
            });
        });

        it('resolves checkout command with custom username and email', () => {
            config.prRef = 'prBranch';
            scm = new GitlabScm({
                oauthClientId: 'myclientid',
                oauthClientSecret: 'myclientsecret',
                username: 'abcd',
                email: 'dev-null@my.email.com'
            });

            return scm.getCheckoutCommand(config).then(command => {
                assert.deepEqual(command, testCustomPrCommands);
            });
        });

        it('resolves checkout command with rootDir', () => {
            config.rootDir = 'path/to/source';
            scm = new GitlabScm({
                oauthClientId: 'myclientid',
                oauthClientSecret: 'myclientsecret',
                username: 'abcd',
                email: 'dev-null@my.email.com'
            });

            return scm.getCheckoutCommand(config).then(command => {
                assert.deepEqual(command, testRootDirCommands);
            });
        });

        it('promises to get the checkout command for a child pipeline', () => {
            config.parentConfig = {
                branch: 'master',
                host: 'github.com',
                org: 'screwdriver-cd',
                repo: 'parent-to-guide',
                sha: '54321'
            };

            return scm.getCheckoutCommand(config).then(command => {
                assert.deepEqual(command, testChildCommands);
            });
        });
    });

    describe('stats', () => {
        it('returns the correct stats', () => {
            assert.deepEqual(scm.stats(), {
                'gitlab:gitlab.com': {
                    requests: {
                        total: 0,
                        timeouts: 0,
                        success: 0,
                        failure: 0,
                        concurrent: 0,
                        averageTime: 0
                    },
                    breaker: {
                        isClosed: true
                    }
                }
            });
        });
    });

    describe('_addWebhook', () => {
        let findWebhookResponse;
        let expectedOptionsFind;
        let expectedOptionsCreate;

        const hookId = 'hookId';
        const apiUrl = 'projects/repoId/hooks';

        beforeEach(() => {
            requestMock.onSecondCall().resolves({
                statusCode: 200
            });
            expectedOptionsFind = {
                url: `${prefixUrl}/${apiUrl}`,
                method: 'GET',
                context: {
                    token
                }
            };
            expectedOptionsCreate = {
                url: `${prefixUrl}/${apiUrl}`,
                method: 'POST',
                context: {
                    token
                },
                json: {
                    url: 'url',
                    push_events: true,
                    merge_requests_events: true
                }
            };
        });

        it('works', () => {
            findWebhookResponse = {
                body: [],
                statusCode: 200
            };

            requestMock.onFirstCall().resolves(findWebhookResponse);

            /* eslint-disable no-underscore-dangle */
            return scm
                ._addWebhook({
                    /* eslint-enable no-underscore-dangle */
                    scmUri,
                    token,
                    webhookUrl: 'url',
                    actions: ['merge_requests_events', 'push_events']
                })
                .then(() => {
                    assert.calledWith(requestMock.firstCall, expectedOptionsFind);
                    assert.calledWith(requestMock.secondCall, expectedOptionsCreate);
                });
        });

        it('updates a pre-existing webhook', () => {
            findWebhookResponse = {
                statusCode: 200,
                body: [
                    {
                        id: hookId,
                        url: 'url',
                        created_at: '2017-03-02T06:38:01.338Z',
                        push_events: true,
                        tag_push_events: false,
                        enable_ssl_verification: true,
                        project_id: 3,
                        issues_events: false,
                        merge_requests_events: true,
                        note_events: false,
                        build_events: false,
                        pipeline_events: false,
                        wiki_page_events: false
                    }
                ]
            };
            expectedOptionsCreate.method = 'PUT';
            expectedOptionsCreate.url = `${prefixUrl}/${apiUrl}/${hookId}`;

            requestMock.onFirstCall().resolves(findWebhookResponse);

            /* eslint-disable no-underscore-dangle */
            return scm
                ._addWebhook({
                    /* eslint-enable no-underscore-dangle */
                    scmUri,
                    token,
                    webhookUrl: 'url',
                    actions: ['merge_requests_events', 'push_events']
                })
                .then(() => {
                    assert.calledWith(requestMock.firstCall, expectedOptionsFind);
                    assert.calledWith(requestMock.secondCall, expectedOptionsCreate);
                });
        });

        it('rejects when failing to get the current list of webhooks', () => {
            const err = new Error(
                '403 Reason "Your credentials lack one or more required privilege scopes." Caller "_findWebhook"'
            );

            err.status = 403;

            requestMock.onFirstCall().rejects(err);

            /* eslint-disable no-underscore-dangle */
            return scm
                ._addWebhook({
                    /* eslint-enable no-underscore-dangle */
                    scmUri,
                    token,
                    webhookUrl: 'url',
                    actions: ['merge_requests_events', 'push_events']
                })
                .then(assert.fail, error => {
                    assert.match(
                        error.message,
                        '403 Reason "Your credentials lack one or more ' +
                            'required privilege scopes." ' +
                            'Caller "_findWebhook"'
                    );
                    assert.match(error.status, 403);
                });
        });

        it('rejects when failing to create a webhook', () => {
            findWebhookResponse = {
                statusCode: 200,
                body: []
            };
            const err = new Error(
                '403 Reason "Your credentials lack one or more required privilege scopes." Caller "_createWebhook"'
            );

            err.status = 403;

            requestMock.onFirstCall().resolves(findWebhookResponse);
            requestMock.onSecondCall().rejects(err);

            /* eslint-disable no-underscore-dangle */
            return scm
                ._addWebhook({
                    /* eslint-enable no-underscore-dangle */
                    scmUri,
                    token,
                    url: 'url',
                    actions: ['merge_requests_events', 'push_events']
                })
                .then(assert.fail, error => {
                    assert.match(
                        error.message,
                        '403 Reason "Your credentials lack one or more ' +
                            'required privilege scopes." ' +
                            'Caller "_createWebhook"'
                    );
                    assert.match(error.status, 403);
                });
        });

        it('rejects when failing to update a webhook', () => {
            findWebhookResponse = {
                statusCode: 200,
                body: [
                    {
                        id: hookId,
                        url: 'url',
                        created_at: '2017-03-02T06:38:01.338Z',
                        push_events: true,
                        tag_push_events: false,
                        enable_ssl_verification: true,
                        project_id: 3,
                        issues_events: false,
                        merge_requests_events: true,
                        note_events: false,
                        build_events: false,
                        pipeline_events: false,
                        wiki_page_events: false
                    }
                ]
            };
            const err = new Error(
                '403 Reason "Your credentials lack one or more required privilege scopes." Caller "_createWebhook"'
            );

            err.status = 403;

            requestMock.onFirstCall().resolves(findWebhookResponse);
            requestMock.onSecondCall().rejects(err);

            /* eslint-disable no-underscore-dangle */
            return scm
                ._addWebhook({
                    /* eslint-enable no-underscore-dangle */
                    scmUri,
                    token,
                    url: 'url',
                    actions: ['merge_requests_events', 'push_events']
                })
                .then(assert.fail, error => {
                    assert.strictEqual(
                        error.message,
                        '403 Reason "Your credentials lack one or more ' +
                            'required privilege scopes." ' +
                            'Caller "_createWebhook"'
                    );
                    assert.match(error.status, 403);
                });
        });
    });

    describe('_getOpenedPRs', () => {
        const apiUrl = 'projects/repoId/merge_requests';
        const expectedOptions = {
            url: `${prefixUrl}/${apiUrl}`,
            method: 'GET',
            context: {
                token
            },
            searchParams: {
                state: 'opened'
            }
        };

        it('returns response of expected format from Gitlab', () => {
            requestMock.resolves({
                statusCode: 200,
                body: [
                    {
                        id: 1,
                        iid: 2,
                        target_branch: 'master',
                        source_branch: 'test1',
                        project_id: 3,
                        title: 'test 1',
                        created_at: '2011-01-26T19:01:12Z',
                        author: { username: 'collab1', web_url: '/collab1' },
                        web_url: '/merge_requests/1'
                    },
                    {
                        id: 2,
                        iid: 3,
                        target_branch: 'master',
                        source_branch: 'test2',
                        project_id: 3,
                        title: 'test 2',
                        created_at: '2011-01-26T19:01:12Z',
                        author: { username: 'collab2', web_url: '/collab2' },
                        web_url: '/merge_requests/2'
                    }
                ]
            });

            // eslint-disable-next-line no-underscore-dangle
            return scm
                ._getOpenedPRs({
                    scmUri,
                    token
                })
                .then(response => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(response, [
                        {
                            name: 'PR-2',
                            ref: 'merge_requests/2',
                            username: 'collab1',
                            title: 'test 1',
                            createTime: '2011-01-26T19:01:12Z',
                            url: '/merge_requests/1',
                            userProfile: '/collab1'
                        },
                        {
                            name: 'PR-3',
                            ref: 'merge_requests/3',
                            username: 'collab2',
                            title: 'test 2',
                            createTime: '2011-01-26T19:01:12Z',
                            url: '/merge_requests/2',
                            userProfile: '/collab2'
                        }
                    ]);
                });
        });
    });

    describe('getScmContexts', () => {
        it('returns a default scmContext', () => {
            const result = scm.getScmContexts();

            return assert.deepEqual(result, ['gitlab:gitlab.com']);
        });

        it('returns a scmContext for user setting gitlabHost', () => {
            scm = new GitlabScm({
                oauthClientId: 'abcdef',
                oauthClientSecret: 'hijklm',
                gitlabHost: 'mygitlab.com'
            });

            const result = scm.getScmContexts();

            return assert.deepEqual(result, ['gitlab:mygitlab.com']);
        });
    });

    describe('canHandleWebhook', () => {
        it('returns a true for opened PR', () => {
            const headers = {
                'content-type': 'application/json',
                'x-gitlab-event': 'Merge Request Hook'
            };

            return scm.canHandleWebhook(headers, testPayloadOpen).then(result => {
                assert.strictEqual(result, true);
            });
        });

        it('returns a true for closed PR', () => {
            const headers = {
                'content-type': 'application/json',
                'x-gitlab-event': 'Merge Request Hook'
            };

            return scm.canHandleWebhook(headers, testPayloadClose).then(result => {
                assert.strictEqual(result, true);
            });
        });

        it('returns a true for push to repo event', () => {
            const headers = {
                'content-type': 'application/json',
                'x-gitlab-event': 'Push Hook'
            };

            return scm.canHandleWebhook(headers, testPayloadPush).then(result => {
                assert.strictEqual(result, true);
            });
        });

        it('returns a false for scm not supporting', () => {
            const headers = {
                'x-hub-signature': 'sha1=a72eab99ad7f36f582f224df8d735091b06f1802',
                'x-github-event': 'pull_request',
                'x-github-delivery': '3c77bf80-9a2f-11e6-80d6-72f7fe03ea29'
            };

            return scm.canHandleWebhook(headers, testPayloadOpen).then(result => {
                assert.strictEqual(result, false);
            });
        });

        it('returns a false when parseHook resolves null', () => {
            const headers = {
                'content-type': 'application/json',
                'x-gitlab-event': 'Push Hook'
            };

            scm._parseHook = sinon.stub();
            scm._parseHook.resolves(null);

            return scm.canHandleWebhook(headers, testPayloadOpen).then(result => {
                assert.strictEqual(result, false);
            });
        });

        it('returns a false when parseHook catches some error', () => {
            const headers = {
                'content-type': 'application/json',
                'x-gitlab-event': 'Push Hook'
            };

            scm._parseHook = sinon.stub().rejects();

            return scm.canHandleWebhook(headers, testPayloadOpen).then(result => {
                assert.strictEqual(result, false);
            });
        });
    });

    describe('openPr', () => {
        it('resolves null', () => {
            scm.openPr({
                checkoutUrl: 'https://hostName/username/repoName/tree/branchName',
                token,
                files: [
                    {
                        name: 'file.txt',
                        content: 'content'
                    }
                ],
                title: 'update file',
                message: 'update file'
            }).then(result => assert.isNull(result));
        });
    });
});
