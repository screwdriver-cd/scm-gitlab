# scm-gitlab
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][status-image]][status-url] [![Open Issues][issues-image]][issues-url] ![License][license-image]

> This scm plugin extends the [scm-base], and provides methods to fetch and update data in Gitlab.

## Usage

```bash
npm install screwdriver-scm-gitlab
```

### Initialization

The class has a variety of knobs to tweak when interacting with GitLab.

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.gitlabHost (gitlab.com) | String | GitLab hostname/port |
| config.gitlabProtocol (https) | String | The protocol to use: http or https |
| config.username (sd-buildbot) | String | GitLab username for checkout |
| config.email (dev-null@screwdriver.cd) | String | GitLab user email for checkout |
| config.https (false) | Boolean | Is the Screwdriver API running over HTTPS |
| config.oauthClientId | String | OAuth Client ID provided by GitLab application |
| config.oauthClientSecret | String | OAuth Client Secret provided by GitLab application |
| config.fusebox ({}) | Object | [Circuit Breaker configuration][circuitbreaker] |

```js
const scm = new GitlabScm({
    oauthClientId: 'abcdef',
    oauthClientSecret: 'hijklm',
    gitlabHost: 'gitlab.com'
});
```

### Methods

#### getScmContexts

No parameters are required.

##### Expected Outcome

A single element array of ScmContext (ex: `['gitlab:gitlab.com']`(default), `['gitlab:mygitlab.com']`), which will be a unique identifier for the scm.

For more information on the exposed methods please see the [scm-base] class.

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
[issues-image]: https://img.shields.io/github/issues/screwdriver-cd/screwdriver.svg
[issues-url]: https://github.com/screwdriver-cd/screwdriver/issues
[status-image]: https://cd.screwdriver.cd/pipelines/1653/badge
[status-url]: https://cd.screwdriver.cd/pipelines/1653
[scm-base]: https://github.com/screwdriver-cd/scm-base
