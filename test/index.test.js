'use strict';

const assert = require('chai').assert;
const mockery = require('mockery');
const sinon = require('sinon');
// const testCommands = require('./data/commands.json');
// const testPrCommands = require('./data/prCommands.json');
// const testCustomPrCommands = require('./data/customPrCommands.json');
const testPayloadOpen = require('./data/gitlab.merge_request.opened.json');
const testPayloadClose = require('./data/gitlab.merge_request.closed.json');
const testPayloadPush = require('./data/gitlab.push.json');

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
                token: 'myAccessToken'
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
                token: 'myAccessToken'
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
                token: 'myAccessToken'
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
                token: 'myAccessToken'
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
                token: 'myAccessToken'
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
                username: 'root',
                checkoutUrl: 'http://example.com/awesome_space/awesome_project.git',
                branch: 'master',
                sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
                prNum: 1,
                prRef: 'ms-viewport',
                hookId: 99
            };
            const headers = {
                'x-event-key': 'pullrequest:created',
                'x-request-uuid': '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };

            return scm.parseHook(headers, testPayloadOpen)
                .then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for closed PR after merged', () => {
            const expected = {
                type: 'pr',
                action: 'closed',
                username: 'robin',
                checkoutUrl: 'https://batman@gitlab.com/batman/test.git',
                branch: 'master',
                sha: '40171b678527',
                prNum: 3,
                prRef: 'mynewbranch',
                hookId: '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };
            const headers = {
                'x-event-key': 'pullrequest:fullfilled',
                'x-request-uuid': '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };

            return scm.parseHook(headers, testPayloadClose)
                .then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for closed PR after declined', () => {
            const expected = {
                type: 'pr',
                action: 'closed',
                username: 'robin',
                checkoutUrl: 'https://batman@gitlab.com/batman/test.git',
                branch: 'master',
                sha: '40171b678527',
                prNum: 3,
                prRef: 'mynewbranch',
                hookId: '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };
            const headers = {
                'x-event-key': 'pullrequest:rejected',
                'x-request-uuid': '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };

            return scm.parseHook(headers, testPayloadClose)
                .then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for push to repo event', () => {
            const expected = {
                type: 'repo',
                action: 'push',
                username: 'robin',
                checkoutUrl: 'https://batman@gitlab.com/batman/test.git',
                branch: 'stuff',
                sha: '9ff49b2d1437567cad2b5fed7a0706472131e927',
                hookId: '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };
            const headers = {
                'x-event-key': 'repo:push',
                'x-request-uuid': '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
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

    // describe('decorateAuthor', () => {
    //     const apiUrl = 'https://gitlab.com/api/v3/users/batman';
    //     const expectedOptions = {
    //         url: apiUrl,
    //         method: 'GET',
    //         json: true,
    //         auth: {
    //             bearer: token
    //         }
    //     };
    //     let fakeResponse;
    //
    //     beforeEach(() => {
    //         fakeResponse = {
    //             statusCode: 200,
    //             body: {
    //                 username: 'batman',
    //                 display_name: 'Batman',
    //                 uuid: '{4f1a9b7f-586e-4e80-b9eb-a7589b4a165f}',
    //                 links: {
    //                     html: {
    //                         href: 'https://gitlab.com/batman/'
    //                     },
    //                     avatar: {
    //                         href: 'https://gitlab.com/account/batman/avatar/32/'
    //                     }
    //                 }
    //             }
    //         };
    //         requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
    //     });
    //
    //     it('resolves to correct decorated author', () => {
    //         const expected = {
    //             url: 'https://gitlab.com/batman/',
    //             name: 'Batman',
    //             username: 'batman',
    //             avatar: 'https://gitlab.com/account/batman/avatar/32/'
    //         };
    //
    //         return scm.decorateAuthor({
    //             username: 'batman',
    //             token
    //         }).then((decorated) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.deepEqual(decorated, expected);
    //         });
    //     });
    //
    //     it('rejects if status code is not 200', () => {
    //         fakeResponse = {
    //             statusCode: 404,
    //             body: {
    //                 error: {
    //                     message: 'Resource not found',
    //                     detail: 'There is no API hosted at this URL'
    //                 }
    //             }
    //         };
    //
    //         requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
    //
    //         return scm.decorateAuthor({
    //             username: 'batman',
    //             token
    //         }).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((error) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.match(error.message, 'STATUS CODE 404');
    //         });
    //     });
    //
    //     it('rejects if fails', () => {
    //         const err = new Error('Gitlab API error');
    //
    //         requestMock.yieldsAsync(err);
    //
    //         return scm.decorateAuthor({
    //             username: 'batman',
    //             token
    //         }).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((error) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.equal(error, err);
    //         });
    //     });
    // });
    //
    // describe('decorateUrl', () => {
    //     const apiUrl = 'https://gitlab.com/api/v3/repositories/repoId';
    //     const selfLink = 'https://gitlab.com/d2lam2/test';
    //     const repoOptions = {
    //         url: apiUrl,
    //         method: 'GET',
    //         json: true,
    //         auth: {
    //             bearer: token
    //         }
    //     };
    //     let fakeResponse;
    //     let expectedOptions;
    //
    //     beforeEach(() => {
    //         fakeResponse = {
    //             statusCode: 200,
    //             body: {
    //                 full_name: 'username/branchName',
    //                 links: {
    //                     html: {
    //                         href: selfLink
    //                     }
    //                 }
    //             }
    //         };
    //         expectedOptions = {
    //             url: apiUrl,
    //             method: 'GET',
    //             json: true,
    //             auth: {
    //                 bearer: token
    //             }
    //         };
    //         requestMock.withArgs(repoOptions)
    //             .yieldsAsync(null, fakeResponse, fakeResponse.body);
    //     });
    //
    //     it('resolves to correct decorated url object', () => {
    //         const expected = {
    //             url: selfLink,
    //             name: 'username/branchName',
    //             branch: 'branchName'
    //         };
    //
    //         return scm.decorateUrl({
    //             scmUri: 'hostName:repoId:branchName',
    //             token
    //         }).then((decorated) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.deepEqual(decorated, expected);
    //         });
    //     });
    //
    //     it('rejects if status code is not 200', () => {
    //         fakeResponse = {
    //             statusCode: 404,
    //             body: {
    //                 error: {
    //                     message: 'Resource not found',
    //                     detail: 'There is no API hosted at this URL'
    //                 }
    //             }
    //         };
    //
    //         requestMock.withArgs(repoOptions).yieldsAsync(null, fakeResponse, fakeResponse.body);
    //
    //         return scm.decorateUrl({
    //             scmUri: 'hostName:repoId:branchName',
    //             token
    //         }).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((error) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.match(error.message, 'STATUS CODE 404');
    //         });
    //     });
    //
    //     it('rejects if fails', () => {
    //         const err = new Error('Gitlab API error');
    //
    //         requestMock.withArgs(repoOptions).yieldsAsync(err);
    //
    //         return scm.decorateUrl({
    //             scmUri: 'repoName:repoId:branchName',
    //             token
    //         }).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((error) => {
    //             assert.called(requestMock);
    //             assert.equal(error, err);
    //         });
    //     });
    // });
    //
    // describe('decorateCommit', () => {
    //     const sha = '1111111111111111111111111111111111111111';
    //     const repoUrl =
    //         `https://gitlab.com/api/v3/repositories/repoId/commit/${sha}`;
    //     const authorUrl = 'https://gitlab.com/api/v3/users/username';
    //     const selfLink = `https://gitlab.com/repoId/commits/${sha}`;
    //     const repoOptions = {
    //         url: repoUrl,
    //         method: 'GET',
    //         json: true,
    //         auth: {
    //             bearer: token
    //         }
    //     };
    //     const authorOptions = {
    //         url: authorUrl,
    //         method: 'GET',
    //         json: true,
    //         auth: {
    //             bearer: token
    //         }
    //     };
    //     let fakeResponse;
    //     let fakeAuthorResponse;
    //
    //     beforeEach(() => {
    //         fakeResponse = {
    //             statusCode: 200,
    //             body: {
    //                 message: 'testing',
    //                 links: {
    //                     html: {
    //                         href: selfLink
    //                     }
    //                 },
    //                 author: {
    //                     user: {
    //                         username: 'username'
    //                     }
    //                 }
    //             }
    //         };
    //         fakeAuthorResponse = {
    //             statusCode: 200,
    //             body: {
    //                 username: 'username',
    //                 display_name: 'displayName',
    //                 uuid: 'uuid',
    //                 links: {
    //                     html: {
    //                         href: 'https://gitlab.com/username/'
    //                     },
    //                     avatar: {
    //                         href: 'https://gitlab.com/account/username/avatar/32/'
    //                     }
    //                 }
    //             }
    //         };
    //         requestMock.withArgs(repoOptions)
    //             .yieldsAsync(null, fakeResponse, fakeResponse.body);
    //         requestMock.withArgs(authorOptions)
    //             .yieldsAsync(null, fakeAuthorResponse, fakeAuthorResponse.body);
    //     });
    //
    //     it('resolves to correct decorated object', () => {
    //         const expected = {
    //             url: selfLink,
    //             message: 'testing',
    //             author: {
    //                 url: 'https://gitlab.com/username/',
    //                 name: 'displayName',
    //                 username: 'username',
    //                 avatar: 'https://gitlab.com/account/username/avatar/32/'
    //             }
    //         };
    //
    //         return scm.decorateCommit({
    //             sha,
    //             scmUri: 'hostName:repoId:branchName',
    //             token
    //         }).then((decorated) => {
    //             assert.calledTwice(requestMock);
    //             assert.deepEqual(decorated, expected);
    //         });
    //     });
    //
    //     it('rejects if status code is not 200', () => {
    //         fakeResponse = {
    //             statusCode: 404,
    //             body: {
    //                 error: {
    //                     message: 'Resource not found',
    //                     detail: 'There is no API hosted at this URL'
    //                 }
    //             }
    //         };
    //
    //         requestMock.withArgs(repoOptions).yieldsAsync(null, fakeResponse, fakeResponse.body);
    //
    //         return scm.decorateCommit({
    //             sha,
    //             scmUri: 'hostName:repoId:branchName',
    //             token
    //         }).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((error) => {
    //             assert.calledOnce(requestMock);
    //             assert.match(error.message, 'STATUS CODE 404');
    //         });
    //     });
    //
    //     it('rejects if fails', () => {
    //         const err = new Error('Gitlab API error');
    //
    //         requestMock.withArgs(repoOptions).yieldsAsync(err);
    //
    //         return scm.decorateCommit({
    //             sha,
    //             scmUri: 'hostName:repoId:branchName',
    //             token
    //         }).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((error) => {
    //             assert.called(requestMock);
    //             assert.equal(error, err);
    //         });
    //     });
    // });
    //
    // describe('getCommitSha', () => {
    //     const apiUrl =
    //         'https://gitlab.com/api/v3/repositories/repoId/refs/branches/branchName';
    //     const scmUri = 'hostName:repoId:branchName';
    //     const expectedOptions = {
    //         url: apiUrl,
    //         method: 'GET',
    //         json: true,
    //         auth: {
    //             bearer: token
    //         }
    //     };
    //     let fakeResponse;
    //
    //     beforeEach(() => {
    //         fakeResponse = {
    //             statusCode: 200,
    //             body: {
    //                 target: {
    //                     hash: 'hashValue'
    //                 }
    //             }
    //         };
    //         requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
    //     });
    //
    //     it('resolves to correct commit sha', () =>
    //         scm.getCommitSha({
    //             scmUri,
    //             token
    //         }).then((sha) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.deepEqual(sha, 'hashValue');
    //         })
    //     );
    //
    //     it('rejects if status code is not 200', () => {
    //         fakeResponse = {
    //             statusCode: 404,
    //             body: {
    //                 error: {
    //                     message: 'Resource not found',
    //                     detail: 'There is no API hosted at this URL'
    //                 }
    //             }
    //         };
    //
    //         requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
    //
    //         return scm.getCommitSha({
    //             scmUri,
    //             token
    //         }).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((error) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.match(error.message, 'STATUS CODE 404');
    //         });
    //     });
    //
    //     it('rejects if fails', () => {
    //         const err = new Error('Gitlab API error');
    //
    //         requestMock.yieldsAsync(err);
    //
    //         return scm.getCommitSha({
    //             scmUri,
    //             token
    //         }).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((error) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.equal(error, err);
    //         });
    //     });
    // });
    //
    // describe('getFile', () => {
    //     const apiUrl = 'https://gitlab.com/api/v3/repositories/repoId/src/branchName' +
    //                    '/path/to/file.txt';
    //     const scmUri = 'hostName:repoId:branchName';
    //     const params = {
    //         scmUri,
    //         token,
    //         path: 'path/to/file.txt'
    //     };
    //     const expectedOptions = {
    //         url: apiUrl,
    //         method: 'GET',
    //         json: true,
    //         auth: {
    //             bearer: token
    //         }
    //     };
    //     let fakeResponse;
    //
    //     beforeEach(() => {
    //         fakeResponse = {
    //             statusCode: 200,
    //             body: {
    //                 node: 'nodeValue',
    //                 path: 'path/to/file.txt',
    //                 data: 'dataValue',
    //                 size: 14
    //             }
    //         };
    //         requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
    //     });
    //
    //     it('resolves to correct commit sha', () =>
    //         scm.getFile(params).then((content) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.deepEqual(content, 'dataValue');
    //         })
    //     );
    //
    //     it('rejects if status code is not 200', () => {
    //         fakeResponse = {
    //             statusCode: 404,
    //             body: {
    //                 error: {
    //                     message: 'Resource not found',
    //                     detail: 'There is no API hosted at this URL'
    //                 }
    //             }
    //         };
    //
    //         requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
    //
    //         return scm.getFile(params).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((error) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.match(error.message, 'STATUS CODE 404');
    //         });
    //     });
    //
    //     it('rejects if fails', () => {
    //         const err = new Error('Gitlab API error');
    //
    //         requestMock.yieldsAsync(err);
    //
    //         return scm.getFile(params).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((error) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.equal(error, err);
    //         });
    //     });
    // });
    //
    // describe('getPermissions', () => {
    //     const pull = {
    //         url: 'https://gitlab.com/api/v3/repositories/repoIdPrefix',
    //         method: 'GET',
    //         json: true,
    //         auth: {
    //             bearer: token
    //         }
    //     };
    //     const push = {
    //         url: 'https://gitlab.com/api/v3/repositories/repoIdPrefix?role=contributor',
    //         method: 'GET',
    //         json: true,
    //         auth: {
    //             bearer: token
    //         }
    //     };
    //     const admin = {
    //         url: 'https://gitlab.com/api/v3/repositories/repoIdPrefix?role=admin',
    //         method: 'GET',
    //         json: true,
    //         auth: {
    //             bearer: token
    //         }
    //     };
    //     const readResponse = {
    //         statusCode: 200,
    //         body: {
    //             values: [
    //                 { uuid: 'repoIdSuffix1' },
    //                 { uuid: 'repoIdSuffix2' },
    //                 { uuid: 'repoIdSuffix3' }
    //             ]
    //         }
    //     };
    //     const writeResponse = {
    //         statusCode: 200,
    //         body: {
    //             values: [
    //                 { uuid: 'repoIdSuffix1' },
    //                 { uuid: 'repoIdSuffix2' }
    //             ]
    //         }
    //     };
    //     const adminResponse = {
    //         statusCode: 200,
    //         body: {
    //             values: [
    //                 { uuid: 'repoIdSuffix1' }
    //             ]
    //         }
    //     };
    //
    //     beforeEach(() => {
    //         requestMock.withArgs(pull).yieldsAsync(null, readResponse, readResponse.body);
    //         requestMock.withArgs(push).yieldsAsync(null, writeResponse, writeResponse.body);
    //         requestMock.withArgs(admin).yieldsAsync(null, adminResponse, adminResponse.body);
    //     });
    //
    //     it('get correct admin permissions', () => {
    //         const scmUri = 'hostName:repoIdPrefix/repoIdSuffix1:branchName';
    //
    //         return scm.getPermissions({
    //             scmUri,
    //             token
    //         }).then((permissions) => {
    //             assert.calledThrice(requestMock);
    //             assert.calledWith(requestMock, pull);
    //             assert.calledWith(requestMock, push);
    //             assert.calledWith(requestMock, admin);
    //             assert.deepEqual(permissions, {
    //                 admin: true,
    //                 push: true,
    //                 pull: true
    //             });
    //         });
    //     });
    //
    //     it('get correct push permissions', () => {
    //         const scmUri = 'hostName:repoIdPrefix/repoIdSuffix2:branchName';
    //
    //         return scm.getPermissions({
    //             scmUri,
    //             token
    //         }).then((permissions) => {
    //             assert.calledThrice(requestMock);
    //             assert.calledWith(requestMock, pull);
    //             assert.calledWith(requestMock, push);
    //             assert.calledWith(requestMock, admin);
    //             assert.deepEqual(permissions, {
    //                 admin: false,
    //                 push: true,
    //                 pull: true
    //             });
    //         });
    //     });
    //
    //     it('get correct pull permissions', () => {
    //         const scmUri = 'hostName:repoIdPrefix/repoIdSuffix3:branchName';
    //
    //         return scm.getPermissions({
    //             scmUri,
    //             token
    //         }).then((permissions) => {
    //             assert.deepEqual(permissions, {
    //                 admin: false,
    //                 push: false,
    //                 pull: true
    //             });
    //         });
    //     });
    //
    //     it('no permissions', () => {
    //         const scmUri = 'hostName:repoIdPrefix/repoIdSuffix:branchName';
    //
    //         return scm.getPermissions({
    //             scmUri,
    //             token
    //         }).then((permissions) => {
    //             assert.deepEqual(permissions, {
    //                 admin: false,
    //                 push: false,
    //                 pull: false
    //             });
    //         });
    //     });
    //
    //     it('rejects if status code is not 200', () => {
    //         const scmUri = 'hostName:repoIdPrefix/repoIdSuffix:branchName';
    //         const fakeResponse = {
    //             statusCode: 404,
    //             body: {
    //                 error: {
    //                     message: 'Resource not found',
    //                     detail: 'There is no API hosted at this URL'
    //                 }
    //             }
    //         };
    //
    //         requestMock.withArgs(pull).yieldsAsync(null, fakeResponse, fakeResponse.body);
    //
    //         return scm.getPermissions({
    //             scmUri,
    //             token
    //         }).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((error) => {
    //             assert.match(error.message, 'STATUS CODE 404');
    //         });
    //     });
    //
    //     it('rejects if fails', () => {
    //         const error = new Error('Gitlab API error');
    //         const scmUri = 'hostName:repoIdPrefix/repoIdSuffix:branchName';
    //
    //         requestMock.withArgs(pull).yieldsAsync(error);
    //
    //         return scm.getPermissions({
    //             scmUri,
    //             token
    //         }).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((err) => {
    //             assert.equal(error, err);
    //         });
    //     });
    // });
    //
    // describe('updateCommitStatus', () => {
    //     let config;
    //     let apiUrl;
    //     let fakeResponse;
    //     let expectedOptions;
    //
    //     beforeEach(() => {
    //         config = {
    //             scmUri: 'hostName:repoId:branchName',
    //             sha: '1111111111111111111111111111111111111111',
    //             buildStatus: 'SUCCESS',
    //             token: 'bearerToken',
    //             url: 'http://valid.url',
    //             jobName: 'main'
    //         };
    //         apiUrl = 'https://gitlab.com/api/v3/repositories/repoId/commit/' +
    //                  `${config.sha}/statuses/build`;
    //         fakeResponse = {
    //             statusCode: 201
    //         };
    //         expectedOptions = {
    //             url: apiUrl,
    //             method: 'POST',
    //             json: true,
    //             body: {
    //                 url: config.url,
    //                 state: 'SUCCESSFUL',
    //                 key: config.sha,
    //                 description: 'Screwdriver/main'
    //             },
    //             auth: {
    //                 bearer: 'bearerToken'     // Decoded access token
    //             }
    //         };
    //         requestMock.yieldsAsync(null, fakeResponse);
    //     });
    //
    //     it('successfully update status', () =>
    //         scm.updateCommitStatus(config).then(() => {
    //             assert.calledWith(requestMock, expectedOptions);
    //         })
    //     );
    //
    //     it('successfully update status with correct values', () => {
    //         config.buildStatus = 'ABORTED';
    //         delete config.jobName;
    //
    //         expectedOptions.body.state = 'STOPPED';
    //         expectedOptions.body.description = 'Screwdriver';
    //
    //         return scm.updateCommitStatus(config).then(() => {
    //             assert.calledWith(requestMock, expectedOptions);
    //         });
    //     });
    //
    //     it('rejects if status code is not 201 or 200', () => {
    //         fakeResponse = {
    //             statusCode: 401,
    //             body: {
    //                 error: {
    //                     message: 'Access token expired'
    //                 }
    //             }
    //         };
    //
    //         requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
    //
    //         return scm.updateCommitStatus(config).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((error) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.match(error.message, 'STATUS CODE 401');
    //         });
    //     });
    //
    //     it('rejects if fails', () => {
    //         const err = new Error('Gitlab API error');
    //
    //         requestMock.yieldsAsync(err);
    //
    //         return scm.updateCommitStatus(config).then(() => {
    //             assert.fail('Should not get here');
    //         }).catch((error) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.equal(error, err);
    //         });
    //     });
    // });
    //
    // describe('getBellConfiguration', () => {
    //     it('resolves a default configuration', () =>
    //         scm.getBellConfiguration().then((config) => {
    //             assert.deepEqual(config, {
    //                 clientId: 'myclientid',
    //                 clientSecret: 'myclientsecret',
    //                 config: {
    //                     uri: 'https://gitlab.com'
    //                 },
    //                 forceHttps: false,
    //                 isSecure: false,
    //                 provider: 'gitlab'
    //             });
    //         })
    //     );
    // });
    //
    // describe('getCheckoutCommand', () => {
    //     const config = {
    //         branch: 'branchName',
    //         host: 'hostName',
    //         org: 'orgName',
    //         repo: 'repoName',
    //         sha: 'shaValue'
    //     };
    //
    //     it('resolves checkout command without prRef', () =>
    //         scm.getCheckoutCommand(config).then((command) => {
    //             assert.deepEqual(command, testCommands);
    //         })
    //     );
    //
    //     it('resolves checkout command with prRef', () => {
    //         config.prRef = 'prBranch';
    //
    //         return scm.getCheckoutCommand(config).then((command) => {
    //             assert.deepEqual(command, testPrCommands);
    //         });
    //     });
    //
    //     it('resolves checkout command with custom username and email', () => {
    //         scm = new GitlabScm({
    //             oauthClientId: 'myclientid',
    //             oauthClientSecret: 'myclientsecret',
    //             username: 'abcd',
    //             email: 'dev-null@my.email.com'
    //         });
    //
    //         return scm.getCheckoutCommand(config)
    //             .then((command) => {
    //                 assert.deepEqual(command, testCustomPrCommands);
    //             });
    //     });
    // });
    //
    // describe('stats', () => {
    //     it('returns the correct stats', () => {
    //         assert.deepEqual(scm.stats(), {
    //             requests: {
    //                 total: 0,
    //                 timeouts: 0,
    //                 success: 0,
    //                 failure: 0,
    //                 concurrent: 0,
    //                 averageTime: 0
    //             },
    //             breaker: {
    //                 isClosed: true
    //             }
    //         });
    //     });
    // });
    //
    // describe('_addWebhook', () => {
    //     const oauthToken = 'oauthToken';
    //     const scmUri = 'hostName:repoId:branchName';
    //
    //     beforeEach(() => {
    //         requestMock.yieldsAsync(null, {
    //             statusCode: 200
    //         });
    //     });
    //
    //     it('works', () => {
    //         requestMock.onFirstCall().yieldsAsync(null, {
    //             body: {
    //                 values: [],
    //                 size: 0
    //             },
    //             statusCode: 200
    //         });
    //
    //         /* eslint-disable no-underscore-dangle */
    //         return scm._addWebhook({
    //         /* eslint-enable no-underscore-dangle */
    //             scmUri,
    //             token: oauthToken,
    //             url: 'url'
    //         })
    //         .then(() => {
    //             assert.calledWith(requestMock, {
    //                 json: true,
    //                 method: 'GET',
    //                 auth: {
    //                     bearer: oauthToken
    //                 },
    //                 url: 'https://gitlab.com/api/v3/projects/repoId/hooks'
    //             });
    //             assert.calledWith(requestMock, {
    //                 body: {
    //                     description: 'Screwdriver-CD build trigger',
    //                     url: 'url',
    //                     active: true,
    //                     events: [
    //                         'repo:push',
    //                         'pullrequest:created',
    //                         'pullrequest:fulfilled',
    //                         'pullrequest:rejected',
    //                         'pullrequest:updated'
    //                     ]
    //                 },
    //                 json: true,
    //                 method: 'POST',
    //                 auth: {
    //                     bearer: oauthToken
    //                 },
    //                 url: 'https://gitlab.com/api/v3/projects/repoId/hooks'
    //             });
    //         });
    //     });
    //
    //     it('updates a pre-existing webhook', () => {
    //         const uuid = 'uuidValue';
    //
    //         requestMock.onFirstCall().yieldsAsync(null, {
    //             body: {
    //                 pagelen: 30,
    //                 values: [{
    //                     url: 'url',
    //                     uuid
    //                 }],
    //                 page: 1,
    //                 size: 3
    //             },
    //             statusCode: 200
    //         });
    //
    //         /* eslint-disable no-underscore-dangle */
    //         return scm._addWebhook({
    //         /* eslint-enable no-underscore-dangle */
    //             scmUri,
    //             token: oauthToken,
    //             url: 'url'
    //         }).then(() => {
    //             assert.calledWith(requestMock, {
    //                 json: true,
    //                 method: 'GET',
    //                 auth: {
    //                     bearer: oauthToken
    //                 },
    //                 url: 'https://gitlab.com/api/v3/projects/repoId/hooks'
    //             });
    //             assert.calledWith(requestMock, {
    //                 body: {
    //                     description: 'Screwdriver-CD build trigger',
    //                     url: 'url',
    //                     active: true,
    //                     events: [
    //                         'repo:push',
    //                         'pullrequest:created',
    //                         'pullrequest:fulfilled',
    //                         'pullrequest:rejected',
    //                         'pullrequest:updated'
    //                     ]
    //                 },
    //                 json: true,
    //                 method: 'PUT',
    //                 auth: {
    //                     bearer: oauthToken
    //                 },
    //                 url: `https://gitlab.com/api/v3/projects/repoId/hooks/${uuid}`
    //             });
    //         });
    //     });
    //
    //     it('updates a hook on a repo with a lot of other hooks', () => {
    //         const fakeValues = [];
    //         const uuid = 'uuid';
    //
    //         for (let i = 0; i < 30; i += 1) {
    //             fakeValues.push({});
    //         }
    //
    //         requestMock.onFirstCall().yieldsAsync(null, {
    //             body: {
    //                 pagelen: 30,
    //                 values: fakeValues,
    //                 page: 1,
    //                 size: 30
    //             },
    //             statusCode: 200
    //         });
    //         requestMock.onSecondCall().yieldsAsync(null, {
    //             body: {
    //                 pagelen: 30,
    //                 values: [{
    //                     url: 'url',
    //                     uuid: 'uuid'
    //                 }],
    //                 page: 2,
    //                 size: 1
    //             },
    //             statusCode: 200
    //         });
    //
    //         /* eslint-disable no-underscore-dangle */
    //         return scm._addWebhook({
    //         /* eslint-enable no-underscore-dangle */
    //             scmUri,
    //             token: oauthToken,
    //             url: 'url'
    //         }).then(() => {
    //             assert.calledWith(requestMock, {
    //                 json: true,
    //                 method: 'GET',
    //                 auth: {
    //                     bearer: oauthToken
    //                 },
    //                 url: 'https://gitlab.com/api/v3/projects/repoId/hooks'
    //             });
    //             assert.calledWith(requestMock, {
    //                 body: {
    //                     description: 'Screwdriver-CD build trigger',
    //                     url: 'url',
    //                     active: true,
    //                     events: [
    //                         'repo:push',
    //                         'pullrequest:created',
    //                         'pullrequest:fulfilled',
    //                         'pullrequest:rejected',
    //                         'pullrequest:updated'
    //                     ]
    //                 },
    //                 json: true,
    //                 method: 'PUT',
    //                 auth: {
    //                     bearer: oauthToken
    //                 },
    //                 url: `https://gitlab.com/api/v3/projects/repoId/hooks/${uuid}`
    //             });
    //         });
    //     });
    //
    //     it('rejects when failing to get the current list of webhooks', () => {
    //         const expectedMessage = [
    //             'Your credentials lack one or more required privilege scopes.',
    //             'Reason "webhook"'
    //         ].join(' ');
    //         const testErrorBody = {
    //             type: 'error',
    //             error: {
    //                 message: 'Your credentials lack one or more required privilege scopes.',
    //                 detail: {
    //                     granted: ['repository'],
    //                     required: ['webhook']
    //                 }
    //             }
    //         };
    //
    //         requestMock.onFirstCall().yieldsAsync(null, {
    //             body: testErrorBody,
    //             statusCode: 403
    //         });
    //
    //         /* eslint-disable no-underscore-dangle */
    //         return scm._addWebhook({
    //         /* eslint-enable no-underscore-dangle */
    //             scmUri,
    //             token,
    //             url: 'url'
    //         }).then(assert.fail, (err) => {
    //             assert.strictEqual(err.message, expectedMessage);
    //         });
    //     });
    //
    //     it('rejects with a stringified error when bitbucket API fails to list webhooks', () => {
    //         const statusCode = 500;
    //         const expectedMessage = `SCM service unavailable (${statusCode}). Reason "undefined"`;
    //
    //         requestMock.onFirstCall().yieldsAsync(null, {
    //             body: undefined,
    //             statusCode
    //         });
    //
    //         /* eslint-disable no-underscore-dangle */
    //         return scm._addWebhook({
    //         /* eslint-enable no-underscore-dangle */
    //             scmUri,
    //             token,
    //             url: 'url'
    //         }).then(assert.fail, (err) => {
    //             assert.strictEqual(err.message, expectedMessage);
    //         });
    //     });
    //
    //     it('rejects when failing to create a webhook', () => {
    //         const testErrorBody = {
    //             type: 'error',
    //             error: {
    //                 message: 'Your credentials lack one or more required privilege scopes.',
    //                 detail: {
    //                     granted: ['repository'],
    //                     required: ['webhook']
    //                 }
    //             }
    //         };
    //
    //         requestMock.onFirstCall().yieldsAsync(null, {
    //             body: {
    //                 values: [],
    //                 size: 0
    //             },
    //             statusCode: 200
    //         });
    //         requestMock.onSecondCall().yieldsAsync(null, {
    //             body: testErrorBody,
    //             statusCode: 403
    //         });
    //
    //         /* eslint-disable no-underscore-dangle */
    //         return scm._addWebhook({
    //         /* eslint-enable no-underscore-dangle */
    //             scmUri,
    //             token,
    //             url: 'url'
    //         }).then(assert.fail, (err) => {
    //             assert.strictEqual(err.message, [
    //                 'Your credentials lack one or more required privilege scopes.',
    //                 'Reason "webhook"'
    //             ].join(' '));
    //         });
    //     });
    //
    //     it('rejects when failing to update a webhook', () => {
    //         const expectedMessage = [
    //             'Your credentials lack one or more required privilege scopes.',
    //             'Reason "webhook"'
    //         ].join(' ');
    //         const testErrorBody = {
    //             type: 'error',
    //             error: {
    //                 message: 'Your credentials lack one or more required privilege scopes.',
    //                 detail: {
    //                     granted: ['repository'],
    //                     required: ['webhook']
    //                 }
    //             }
    //         };
    //
    //         requestMock.onFirstCall().yieldsAsync(null, {
    //             body: {
    //                 values: [{
    //                     url: 'url',
    //                     uuid: 'uuid'
    //                 }],
    //                 size: 1
    //             },
    //             statusCode: 200
    //         });
    //         requestMock.onSecondCall().yieldsAsync(null, {
    //             body: testErrorBody,
    //             statusCode: 403
    //         });
    //
    //         /* eslint-disable no-underscore-dangle */
    //         return scm._addWebhook({
    //         /* eslint-enable no-underscore-dangle */
    //             scmUri,
    //             token,
    //             url: 'url'
    //         }).then(assert.fail, (err) => {
    //             assert.strictEqual(err.message, expectedMessage);
    //         });
    //     });
    //
    //     it('rejects with a stringified error when bitbucket API fails to update webhook', () => {
    //         const statusCode = 500;
    //         const expectedMessage = `SCM service unavailable (${statusCode}). Reason "{}"`;
    //
    //         requestMock.onFirstCall().yieldsAsync(null, {
    //             body: {
    //                 values: [{
    //                     url: 'url',
    //                     uuid: 'uuid'
    //                 }],
    //                 size: 1
    //             },
    //             statusCode: 200
    //         });
    //         requestMock.onSecondCall().yieldsAsync(null, {
    //             body: {},
    //             statusCode
    //         });
    //
    //         /* eslint-disable no-underscore-dangle */
    //         return scm._addWebhook({
    //         /* eslint-enable no-underscore-dangle */
    //             scmUri,
    //             token,
    //             url: 'url'
    //         }).then(assert.fail, (err) => {
    //             assert.strictEqual(err.message, expectedMessage);
    //         });
    //     });
    // });
    //
    // describe('_getOpenedPRs', () => {
    //     const oauthToken = 'oauthToken';
    //     const scmUri = 'hostName:repoId:branchName';
    //     const expectedOptions = {
    //         url: 'https://gitlab.com/api/v3/repositories/repoId/pullrequests',
    //         method: 'GET',
    //         json: true,
    //         auth: {
    //             bearer: oauthToken
    //         }
    //     };
    //
    //     it('returns response of expected format from Gitlab', () => {
    //         requestMock.yieldsAsync(null, {
    //             body: {
    //                 values: [{
    //                     id: 1,
    //                     source: {
    //                         branch: {
    //                             name: 'testbranch'
    //                         }
    //                     }
    //                 }]
    //             },
    //             statusCode: 200
    //         });
    //
    //         // eslint-disable-next-line no-underscore-dangle
    //         return scm._getOpenedPRs({
    //             scmUri,
    //             token: oauthToken
    //         })
    //         .then((response) => {
    //             assert.calledWith(requestMock, expectedOptions);
    //             assert.deepEqual(response, [{
    //                 name: 'PR-1',
    //                 ref: 'testbranch'
    //             }]);
    //         }
    //         );
    //     });
    // });
});
