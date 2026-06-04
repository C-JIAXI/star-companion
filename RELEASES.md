# Releases

This file is the repository release index. Use the files under `docs/releases/` as GitHub Release bodies when publishing tags.

## v0.1.0

- Draft release notes: [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md)
- Suggested tag: `v0.1.0`
- Suggested title: `Star Companion v0.1.0`
- Release type: initial public repository release

## Release Checklist

Before publishing a GitHub Release:

- Confirm `README.md` still matches the current app routes, data model, and product boundary.
- Run the checks relevant to the release scope.
- For desktop releases, run `npm run desktop:build` or trigger `.github/workflows/release.yml`.
- Confirm the release does not include local secrets, API keys, local databases, build caches, or local AI/editor agent instruction files.
- Attach generated desktop artifacts from `dist/desktop` when publishing manually.
