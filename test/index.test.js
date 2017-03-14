'use strict';

const assert = require('chai').assert;
const mockery = require('mockery');
const sinon = require('sinon');
const testCommands = require('./data/commands.json');
const testPrCommands = require('./data/prCommands.json');
const testCustomPrCommands = require('./data/customPrCommands.json');
const testPayloadOpen = require('./data/gitlab.merge_request.opened.json');
const testPayloadClose = require('./data/gitlab.merge_request.closed.json');
const testPayloadPush = require('./data/gitlab.push.json');
const token = 'myAccessToken';

require('sinon-as-promised');
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
        mockery.registerMock('request', requestMock);

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
            oauthClientSecret: 'myclientsecret'
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
                https: false
            });
        });
    });

    describe('parseUrl', () => {
        const apiUrl = 'https://gitlab.com/api/v3/projects/batman%2Ftest';
        let fakeResponse;
        let expectedOptions;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    id: '12345'
                }
            };
            expectedOptions = {
                url: apiUrl,
                method: 'GET',
                json: true,
                auth: {
                    bearer: 'myAccessToken'
                }
            };
            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to the correct parsed url for ssh', () => {
            const expected =
                'gitlab.com:12345:master';

            expectedOptions = {
                url: apiUrl,
                method: 'GET',
                json: true,
                auth: {
                    bearer: 'myAccessToken'
                }
            };

            return scm.parseUrl({
                checkoutUrl: 'git@gitlab.com:batman/test.git#master',
                token
            }).then((parsed) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(parsed, expected);
            });
        });

        it('resolves to the correct parsed url for https', () => {
            const expected =
                'gitlab.com:12345:mynewbranch';

            return scm.parseUrl({
                checkoutUrl: 'https://batman@gitlab.com/batman/test.git#mynewbranch',
                token
            }).then((parsed) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(parsed, expected);
            });
        });

        it('rejects if request fails', () => {
            const err = new Error('Gitlab API error');

            requestMock.yieldsAsync(err);

            return scm.parseUrl({
                checkoutUrl: 'https://batman@gitlab.com/batman/test.git#mynewbranch',
                token
            })
                .then(() => assert.fail('Should not get here'))
                .catch((error) => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(error, err);
                });
        });

        it('rejects if status code is 404', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    message: '404 Project Not Found'
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.parseUrl({
                checkoutUrl: 'https://batman@gitlab.com/batman/test.git#mynewbranch',
                token
            })
                .then(() => assert.fail('Should not get here'))
                .catch((error) => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, '404 Reason "404 Project Not Found" ' +
                                                'Caller "_parseUrl"');
                });
        });

        it('rejects if status code is not 200 & 404', () => {
            fakeResponse = {
                statusCode: 500,
                body: {
                    message: 'Internal Server Error'
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.parseUrl({
                checkoutUrl: 'https://batman@gitlab.com/batman/test.git#mynewbranch',
                token
            })
                .then(() => assert.fail('Should not get here'))
                .catch((error) => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, '500 Reason "Internal Server Error" ' +
                                                'Caller "_parseUrl"');
                });
        });
    });

    describe('parseHook', () => {
        it('resolves the correct parsed config for opened PR', () => {
            const expected = {
                type: 'pr',
                action: 'opened',
                username: 'bdangit',
                checkoutUrl: 'http://example.com/bdangit/quickstart-generic.git',
                branch: 'master',
                sha: '249b26f2278c39f9efc55986f845dd98ae011763',
                prNum: 6,
                prRef: 'tabbycat',
                hookId: null
            };
            const headers = {
                'content-type': 'application/json',
                'x-gitlab-event': 'Merge Request Hook'
            };

            return scm.parseHook(headers, testPayloadOpen)
                .then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for closed PR after merged', () => {
            const expected = {
                type: 'pr',
                action: 'closed',
                username: 'bdangit',
                checkoutUrl: 'http://example.com/bdangit/quickstart-generic.git',
                branch: 'master',
                sha: 'bc2b3a48a428ed23e15960e8d703bf7e3a8a4f54',
                prNum: 2,
                prRef: 'fix-this-stuff',
                hookId: null
            };
            const headers = {
                'content-type': 'application/json',
                'x-gitlab-event': 'Merge Request Hook'
            };

            return scm.parseHook(headers, testPayloadClose)
                .then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for closed PR after declined', () => {
            const expected = {
                type: 'pr',
                action: 'closed',
                username: 'bdangit',
                checkoutUrl: 'http://example.com/bdangit/quickstart-generic.git',
                branch: 'master',
                sha: 'bc2b3a48a428ed23e15960e8d703bf7e3a8a4f54',
                prNum: 2,
                prRef: 'fix-this-stuff',
                hookId: null
            };
            const headers = {
                'content-type': 'application/json',
                'x-gitlab-event': 'Merge Request Hook'
            };

            return scm.parseHook(headers, testPayloadClose)
                .then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for push to repo event', () => {
            const expected = {
                type: 'repo',
                action: 'push',
                username: 'bdangit',
                checkoutUrl: 'http://example.com/bdangit/quickstart-generic.git',
                branch: 'master',
                sha: '76506776e7931f843206c54586266468aec1a92e',
                hookId: null
            };
            const headers = {
                'content-type': 'application/json',
                'x-gitlab-event': 'Push Hook'
            };

            return scm.parseHook(headers, testPayloadPush)
                .then(result => assert.deepEqual(result, expected));
        });

        it('resolves null if events are not supported: repoFork', () => {
            const repoFork = {
                'x-event-key': 'repo:fork'
            };

            return scm.parseHook(repoFork, {})
                .then(result => assert.deepEqual(result, null));
        });

        it('resolves null if events are not supported: prComment', () => {
            const prComment = {
                'x-event-key': 'pullrequest:comment_created'
            };

            return scm.parseHook(prComment, {})
                .then(result => assert.deepEqual(result, null));
        });

        it('resolves null if events are not supported: issueCreated', () => {
            const issueCreated = {
                'x-event-key': 'issue:created'
            };

            return scm.parseHook(issueCreated, {})
                .then(result => assert.deepEqual(result, null));
        });
    });

    describe('decorateAuthor', () => {
        const apiUrl = 'https://gitlab.com/api/v3/users';
        const expectedOptions = {
            url: apiUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            },
            qs: {
                username: 'batman'
            }
        };
        let fakeResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: [{
                    username: 'batman',
                    name: 'Batman',
                    id: 12345,
                    state: 'active',
                    avatar_url: 'https://gitlab.com/uploads/user/avatar/12345/avatar.png',
                    web_url: 'https://gitlab.com/batman'
                }]
            };
            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to correct decorated author', () => {
            const expected = {
                url: 'https://gitlab.com/batman',
                name: 'Batman',
                username: 'batman',
                avatar: 'https://gitlab.com/uploads/user/avatar/12345/avatar.png'
            };

            return scm.decorateAuthor({
                username: 'batman',
                token
            }).then((decorated) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(decorated, expected);
            });
        });

        it('rejects if status code is not 200', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    message: 'Resource not found'
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.decorateAuthor({
                username: 'batman',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, '404 Reason "Resource not found" ' +
                                            'Caller "_decorateAuthor"');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Gitlab API error');

            requestMock.yieldsAsync(err);

            return scm.decorateAuthor({
                username: 'batman',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(error, err);
            });
        });
    });

    describe('decorateUrl', () => {
        const apiUrl = 'https://gitlab.com/api/v3/projects/repoId';
        const repoOptions = {
            url: apiUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
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
                url: apiUrl,
                method: 'GET',
                json: true,
                auth: {
                    bearer: token
                }
            };
            requestMock.withArgs(repoOptions)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to correct decorated url object', () => {
            const expected = {
                url: 'https://hostName/username/repoName/tree/branchName',
                name: 'username/repoName',
                branch: 'branchName'
            };

            return scm.decorateUrl({
                scmUri: 'hostName:repoId:branchName',
                token
            }).then((decorated) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(decorated, expected);
            });
        });

        it('rejects if status code is not 200', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    message: 'Resource not found'
                }
            };

            requestMock.withArgs(repoOptions).yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.decorateUrl({
                scmUri: 'hostName:repoId:branchName',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, '404 Reason "Resource not found" ' +
                                            'Caller "lookupScmUri"');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Gitlab API error');

            requestMock.withArgs(repoOptions).yieldsAsync(err);

            return scm.decorateUrl({
                scmUri: 'repoName:repoId:branchName',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.called(requestMock);
                assert.equal(error, err);
            });
        });
    });

    describe('decorateCommit', () => {
        const sha = '1111111111111111111111111111111111111111';
        let lookupScmUri;
        let lookupScmUriResponse;
        let commitLookup;
        let commitLookupResponse;
        let authorLookup;
        let authorLookupResponse;
        let fakeResponse;

        beforeEach(() => {
            lookupScmUri = {
                json: true,
                method: 'GET',
                auth: {
                    bearer: token
                },
                url: 'https://gitlab.com/api/v3/projects/repoId'
            };
            lookupScmUriResponse = {
                statusCode: 200,
                body: {
                    path_with_namespace: 'owner/repoName'
                }
            };

            commitLookup = {
                json: true,
                method: 'GET',
                auth: {
                    bearer: token
                },
                url: 'https://gitlab.com/api/v3/projects/owner%2FrepoName' +
                     `/repository/commits/${sha}`
            };
            commitLookupResponse = {
                statusCode: 200,
                body: {
                    author_name: 'username',
                    message: 'testing'
                }
            };

            authorLookup = {
                json: true,
                method: 'GET',
                auth: {
                    bearer: token
                },
                url: 'https://gitlab.com/api/v3/users',
                qs: {
                    username: 'username'
                }
            };
            authorLookupResponse = {
                statusCode: 200,
                body: [{
                    username: 'username',
                    name: 'displayName',
                    id: 12345,
                    state: 'active',
                    avatar_url: 'https://gitlab.com/uploads/user/avatar/12345/avatar.png',
                    web_url: 'https://gitlab.com/username'
                }]
            };

            requestMock.withArgs(lookupScmUri)
                .yieldsAsync(null, lookupScmUriResponse, lookupScmUriResponse.body);
            requestMock.withArgs(commitLookup)
                .yieldsAsync(null, commitLookupResponse, commitLookupResponse.body);
            requestMock.withArgs(authorLookup)
                .yieldsAsync(null, authorLookupResponse, authorLookupResponse.body);
        });

        it('resolves to correct decorated object', () => {
            const expected = {
                message: 'testing',
                author: {
                    url: 'https://gitlab.com/username',
                    name: 'displayName',
                    username: 'username',
                    avatar: 'https://gitlab.com/uploads/user/avatar/12345/avatar.png'
                },
                url: `https://gitlab.com/owner/repoName/tree/${sha}`
            };

            return scm.decorateCommit({
                sha,
                scmUri: 'hostName:repoId:branchName',
                token
            }).then((decorated) => {
                assert.calledThrice(requestMock);
                assert.deepEqual(decorated, expected);
            });
        });

        it('rejects if status code is not 200', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    message: 'Resource not found'
                }
            };

            requestMock.withArgs(commitLookup)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.decorateCommit({
                sha,
                scmUri: 'hostName:repoId:branchName',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledTwice(requestMock);
                assert.match(error.message, '404 Reason "Resource not found" ' +
                                            'Caller "_decorateCommit: commitLookup"');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Gitlab API error');

            requestMock.withArgs(commitLookup).yieldsAsync(err);

            return scm.decorateCommit({
                sha,
                scmUri: 'hostName:repoId:branchName',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.called(requestMock);
                assert.equal(error, err);
            });
        });
    });

    describe('getCommitSha', () => {
        const apiUrl = 'https://gitlab.com/api/v3/projects/repoId' +
                       '/repository/branches/branchName';
        const scmUri = 'hostName:repoId:branchName';
        const expectedOptions = {
            url: apiUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
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
            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to correct commit sha', () =>
            scm.getCommitSha({
                scmUri,
                token
            }).then((sha) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(sha, 'hashValue');
            })
        );

        it('rejects if status code is not 200', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    message: 'Resource not found'
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.getCommitSha({
                scmUri,
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, '404 Reason "Resource not found" ' +
                                            'Caller "_getCommitSha"');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Gitlab API error');

            requestMock.yieldsAsync(err);

            return scm.getCommitSha({
                scmUri,
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(error, err);
            });
        });
    });

    describe('getFile', () => {
        const apiUrl = 'https://gitlab.com/api/v3/projects/repoId' +
                       '/repository/files';
        const scmUri = 'hostName:repoId:branchName';
        const params = {
            scmUri,
            token,
            path: 'path/to/file.txt'
        };
        const expectedOptions = {
            url: apiUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            },
            qs: {
                file_path: 'path/to/file.txt',
                ref: 'branchName'
            }
        };
        let fakeResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    encoding: 'ascii',
                    content: 'dataValue'
                }
            };
            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to correct commit sha', () =>
            scm.getFile(params).then((content) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(content, 'dataValue');
            })
        );

        it('rejects if status code is not 200', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    message: 'Resource not found'
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.getFile(params).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, '404 Reason "Resource not found" ' +
                                            'Caller "_getFile"');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Gitlab API error');

            requestMock.yieldsAsync(err);

            return scm.getFile(params).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(error, err);
            });
        });
    });

    describe('getPermissions', () => {
        let expectedOptions;
        let fakeResponse;

        beforeEach(() => {
            expectedOptions = {
                url: 'https://gitlab.com/api/v3/projects/repoId',
                method: 'GET',
                json: true,
                auth: {
                    bearer: token
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

            requestMock.withArgs(expectedOptions)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('get correct permissions for level 50', () => {
            const scmUri = 'hostName:repoId:branchName';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
                assert.calledOnce(requestMock);
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(permissions, {
                    admin: true,
                    push: true,
                    pull: true
                });
            });
        });

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

            requestMock.withArgs(expectedOptions)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);

            const scmUri = 'hostName:repoId:branchName';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
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

            requestMock.withArgs(expectedOptions)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);

            const scmUri = 'hostName:repoId:branchName';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
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

            requestMock.withArgs(expectedOptions)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);

            const scmUri = 'hostName:repoId:branchName';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
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

            requestMock.withArgs(expectedOptions)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);

            const scmUri = 'hostName:repoId:branchName';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
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

            requestMock.withArgs(expectedOptions)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);

            const scmUri = 'hostName:repoId:branchName';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
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

            requestMock.withArgs(expectedOptions)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);

            const scmUri = 'hostName:repoId:branchName';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
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
            const scmUri = 'hostName:repoId:branchName';

            fakeResponse = {
                statusCode: 404,
                body: {
                    message: 'Resource not found'
                }
            };

            requestMock.withArgs(expectedOptions)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.getPermissions({
                scmUri,
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.match(error.message, '404 Reason "Resource not found" ' +
                                            'Caller "_getPermissions"');
            });
        });

        it('rejects if fails', () => {
            const error = new Error('Gitlab API error');
            const scmUri = 'hostName:repoId:branchName';

            requestMock.withArgs(expectedOptions)
                .yieldsAsync(error);

            return scm.getPermissions({
                scmUri,
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((err) => {
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
                scmUri: 'hostName:repoId:branchName',
                sha: '1111111111111111111111111111111111111111',
                buildStatus: 'SUCCESS',
                token,
                url: 'http://valid.url',
                jobName: 'main'
            };
            apiUrl = 'https://gitlab.com/api/v3/projects/repoId/statuses/' +
                     `${config.sha}`;
            fakeResponse = {
                statusCode: 201
            };
            expectedOptions = {
                url: apiUrl,
                method: 'POST',
                json: true,
                qs: {
                    context: 'Screwdriver/main',
                    target_url: config.url,
                    state: 'success',
                    description: 'Everything looks good!'
                },
                auth: {
                    bearer: token
                }
            };
            requestMock.yieldsAsync(null, fakeResponse);
        });

        it('successfully update status', () =>
            scm.updateCommitStatus(config).then(() => {
                assert.calledWith(requestMock, expectedOptions);
            })
        );

        it('successfully update status with correct values', () => {
            config.buildStatus = 'ABORTED';
            delete config.jobName;

            expectedOptions.qs.context = 'Screwdriver';
            expectedOptions.qs.state = 'failure';
            expectedOptions.qs.description = 'Aborted mid-flight';

            return scm.updateCommitStatus(config).then(() => {
                assert.calledWith(requestMock, expectedOptions);
            });
        });

        it('rejects if status code is not 201 or 200', () => {
            fakeResponse = {
                statusCode: 401,
                body: {
                    message: 'Access token expired'
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.updateCommitStatus(config).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, '401 Reason "Access token expired" ' +
                                            'Caller "_updateCommitStatus"');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Gitlab API error');

            requestMock.yieldsAsync(err);

            return scm.updateCommitStatus(config).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(error, err);
            });
        });
    });

    describe('getBellConfiguration', () => {
        it('resolves a default configuration', () =>
            scm.getBellConfiguration().then((config) => {
                assert.deepEqual(config, {
                    clientId: 'myclientid',
                    clientSecret: 'myclientsecret',
                    config: {
                        uri: 'https://gitlab.com'
                    },
                    forceHttps: false,
                    isSecure: false,
                    provider: 'gitlab'
                });
            })
        );
    });

    describe('getCheckoutCommand', () => {
        const config = {
            branch: 'branchName',
            host: 'hostName',
            org: 'orgName',
            repo: 'repoName',
            sha: 'shaValue'
        };

        it('resolves checkout command without prRef', () =>
            scm.getCheckoutCommand(config).then((command) => {
                assert.deepEqual(command, testCommands);
            })
        );

        it('resolves checkout command with prRef', () => {
            config.prRef = 'prBranch';

            return scm.getCheckoutCommand(config).then((command) => {
                assert.deepEqual(command, testPrCommands);
            });
        });

        it('resolves checkout command with custom username and email', () => {
            scm = new GitlabScm({
                oauthClientId: 'myclientid',
                oauthClientSecret: 'myclientsecret',
                username: 'abcd',
                email: 'dev-null@my.email.com'
            });

            return scm.getCheckoutCommand(config)
                .then((command) => {
                    assert.deepEqual(command, testCustomPrCommands);
                });
        });
    });

    describe('stats', () => {
        it('returns the correct stats', () => {
            assert.deepEqual(scm.stats(), {
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
            });
        });
    });

    describe('_addWebhook', () => {
        let findWebhookResponse;
        let createWebhookResponse;
        const hookid = 'hookid';
        const scmUri = 'hostName:repoId:branchName';

        beforeEach(() => {
            requestMock.yieldsAsync(null, {
                statusCode: 200
            });
        });

        it('works', () => {
            findWebhookResponse = {
                body: [],
                statusCode: 200
            };

            requestMock.onFirstCall().yieldsAsync(null, findWebhookResponse);

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token,
                webhookUrl: 'url'
            })
            .then(() => {
                assert.calledWith(requestMock, {
                    json: true,
                    method: 'GET',
                    auth: {
                        bearer: token
                    },
                    url: 'https://gitlab.com/api/v3/projects/repoId/hooks'
                });
                assert.calledWith(requestMock, {
                    json: true,
                    method: 'POST',
                    auth: {
                        bearer: token
                    },
                    url: 'https://gitlab.com/api/v3/projects/repoId/hooks',
                    qs: {
                        url: 'url',
                        push_events: true,
                        merge_requests_events: true
                    }
                });
            });
        });

        it('updates a pre-existing webhook', () => {
            findWebhookResponse = {
                statusCode: 200,
                body: [
                    {
                        id: hookid,
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

            requestMock.onFirstCall().yieldsAsync(null, findWebhookResponse);

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token,
                webhookUrl: 'url'
            }).then(() => {
                assert.calledWith(requestMock, {
                    json: true,
                    method: 'GET',
                    auth: {
                        bearer: token
                    },
                    url: 'https://gitlab.com/api/v3/projects/repoId/hooks'
                });
                assert.calledWith(requestMock, {
                    json: true,
                    method: 'PUT',
                    auth: {
                        bearer: token
                    },
                    url: `https://gitlab.com/api/v3/projects/repoId/hooks/${hookid}`,
                    qs: {
                        url: 'url',
                        push_events: true,
                        merge_requests_events: true
                    }
                });
            });
        });

        it('rejects when failing to get the current list of webhooks', () => {
            findWebhookResponse = {
                statusCode: 403,
                body: {
                    message: 'Your credentials lack one or more required privilege scopes.'
                }
            };

            requestMock.onFirstCall().yieldsAsync(null, findWebhookResponse);

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token,
                webhookUrl: 'url'
            }).then(assert.fail, (error) => {
                assert.match(error.message, '403 Reason "Your credentials lack one or more ' +
                                            'required privilege scopes." ' +
                                            'Caller "_findWebhook"');
            });
        });

        it('rejects with a stringified error when gitlab API fails to list webhooks', () => {
            findWebhookResponse = {
                statusCode: 500,
                body: {
                    blah: 'undefined'
                }
            };

            requestMock.onFirstCall().yieldsAsync(null, findWebhookResponse);

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token,
                url: 'url'
            }).then(assert.fail, (error) => {
                assert.match(error.message, '500 Reason "{"blah":"undefined"}" ' +
                                            'Caller "_findWebhook"');
            });
        });

        it('rejects when failing to create a webhook', () => {
            findWebhookResponse = {
                statusCode: 200,
                body: []
            };
            createWebhookResponse = {
                statusCode: 403,
                body: {
                    message: 'Your credentials lack one or more required privilege scopes.'
                }
            };

            requestMock.onFirstCall().yieldsAsync(null, findWebhookResponse);
            requestMock.onSecondCall().yieldsAsync(null, createWebhookResponse);

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token,
                url: 'url'
            }).then(assert.fail, (error) => {
                assert.match(error.message, '403 Reason "Your credentials lack one or more ' +
                                            'required privilege scopes." ' +
                                            'Caller "_createWebhook"');
            });
        });

        it('rejects when failing to update a webhook', () => {
            findWebhookResponse = {
                statusCode: 200,
                body: [
                    {
                        id: hookid,
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
            createWebhookResponse = {
                statusCode: 403,
                body: {
                    message: 'Your credentials lack one or more required privilege scopes.'
                }
            };

            requestMock.onFirstCall().yieldsAsync(null, findWebhookResponse);
            requestMock.onSecondCall().yieldsAsync(null, createWebhookResponse);

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token,
                url: 'url'
            }).then(assert.fail, (err) => {
                assert.strictEqual(err.message, '403 Reason "Your credentials lack one or more ' +
                                                'required privilege scopes." ' +
                                                'Caller "_createWebhook"');
            });
        });
    });

    describe('_getOpenedPRs', () => {
        const scmUri = 'hostName:repoId:branchName';
        const expectedOptions = {
            url: 'https://gitlab.com/api/v3/projects/repoId/merge_requests',
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            },
            qs: {
                state: 'opened'
            }
        };

        it('returns response of expected format from Gitlab', () => {
            requestMock.yieldsAsync(null, {
                statusCode: 200,
                body: [
                    {
                        id: 1,
                        iid: 1,
                        target_branch: 'master',
                        source_branch: 'test1',
                        project_id: 3
                    },
                    {
                        id: 2,
                        iid: 2,
                        target_branch: 'master',
                        source_branch: 'test2',
                        project_id: 3
                    }
                ]
            });

            // eslint-disable-next-line no-underscore-dangle
            return scm._getOpenedPRs({
                scmUri,
                token
            })
            .then((response) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(response, [
                    {
                        name: 'PR-1',
                        ref: 'test1'
                    },
                    {
                        name: 'PR-2',
                        ref: 'test2'
                    }
                ]);
            });
        });
    });
});
