# Contributing to VerseLink

## Before contributing

Fork the repository and create a branch for your change. For larger changes, opening or discussing an issue first is recommended. Do not discuss security issues publicly; follow [SECURITY.md](SECURITY.md).

## Development setup

VerseLink uses Node.js, PostgreSQL, vanilla HTML/CSS/JavaScript, and Docker. The authoritative setup and architecture details are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/API.md](docs/API.md).

The usual local checks are:

```powershell
npm install
npm test
node --check src/server.js
git diff --check
```

## Branching

Names such as `feature/...`, `fix/...`, and `docs/...` can make the purpose of a branch clear. They are suggestions, not a project requirement.

## Coding principles

- Respect the existing Node.js/PostgreSQL and vanilla frontend architecture.
- Do not introduce frameworks without a clear need.
- Do not append preview or patch scripts after `</html>`.
- Avoid breaking existing APIs without a documented reason.
- Keep permissions enforced by the backend as the source of truth.
- Never commit secrets.
- Keep changes focused and avoid unrelated edits.

## Testing

The project uses the Node.js test runner. Run `npm test`, `node --test`, `node --check src/server.js`, and `git diff --check` as applicable to the change. Only document or rely on commands that exist in `package.json` or the repository documentation.

## Pull requests

Include a short description, the tests you ran, and screenshots for UI changes. Keep unrelated changes out of the pull request.

By contributing to VerseLink, you agree that your contributions are provided under the project's `AGPL-3.0-only` license. No separate copyright transfer or CLA is required by this repository.
