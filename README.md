# scm-gitlab
[![Open Issues][issues-image]][issues-url]

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

For more information on the exposed methods please see the [scm-base-class].

## Testing

```bash
npm test
```

## License

Code licensed under the BSD 3-Clause license. See LICENSE file for terms.

[issues-url]: https://github.com/bdangit/scm-gitlab/issues
[scm-base-class]: https://github.com/screwdriver-cd/scm-base
