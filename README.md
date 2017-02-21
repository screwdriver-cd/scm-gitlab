# scm-gitlab
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][status-image]][status-url] [![Open Issues][issues-image]][issues-url] [![Dependency Status][daviddm-image]][daviddm-url] ![License][license-image]

> This scm plugin extends the [scm-base-class], and provides methods to fetch and update data in gitlab.

## Usage

```bash
npm install screwdriver-scm-gitlab
```

### Initialization

The class has a variety of knobs to tweak when interacting with GitLab.

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.gheHost (null) | String | If using GitLab, the host/port of the deployed instance |
| config.gheProtocol (https) | String | If using GitLab, the protocol to use |
| config.username (sd-buildbot) | String | GitLab username for checkout |
| config.email (dev-null@screwdriver.cd) | String | GitLab user email for checkout |
| config.https (false) | Boolean | Is the Screwdriver API running over HTTPS |
| config.oauthClientId | String | OAuth Client ID provided by GitLab application |
| config.oauthClientSecret | String | OAuth Client Secret provided by GitLab application |
| config.fusebox ({}) | Object | [Circuit Breaker configuration][circuitbreaker] |
| config.secret | String | Secret to validate the signature of webhook events |

```js
const scm = new GitlabScm({
    oauthClientId: 'abcdef',
    oauthClientSecret: 'hijklm',
    secret: 'somesecret'
});
```

### Methods

For more information on the exposed methods please see the [scm-base-class].

## Testing

```bash
npm test
```

## License

Code licensed under the BSD 3-Clause license. See LICENSE file for terms.

[npm-image]: https://img.shields.io/npm/v/screwdriver-scm-gitlab.svg
[npm-url]: https://npmjs.org/package/screwdriver-scm-gitlab
[downloads-image]: https://img.shields.io/npm/dt/screwdriver-scm-gitlab.svg
[license-image]: https://img.shields.io/npm/l/screwdriver-scm-gitlab.svg
[issues-image]: https://img.shields.io/gitlab/issues/screwdriver-cd/screwdriver.svg
[issues-url]: https://gitlab.com/screwdriver-cd/screwdriver/issues
[status-image]: https://cd.screwdriver.cd/pipelines/8/badge
[status-url]: https://cd.screwdriver.cd/pipelines/8
[daviddm-image]: https://david-dm.org/screwdriver-cd/scm-gitlab.svg?theme=shields.io
[daviddm-url]: https://david-dm.org/screwdriver-cd/scm-gitlab
[scm-base-class]: https://gitlab.com/screwdriver-cd/scm-base
