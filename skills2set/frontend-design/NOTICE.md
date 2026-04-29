# NOTICE — Vendored Skill

This `frontend-design` skill is vendored from upstream and ships with Lynn.

- **Upstream**: [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design)
- **License**: Apache License 2.0 (see `LICENSE.txt`)
- **Vendored at**: 2026-04-29
- **Lynn version**: v0.78.x
- **Upstream commit**: pinned to anthropics/skills `main` branch as of vendor date

## Why Vendored

Pre-installing this skill so every Lynn user gets professional frontend-design
guidance without needing `npx skills add` or any external setup.

## Updating

To pull a newer version of this skill:

```bash
# 1. Re-clone upstream
git clone --depth 1 https://github.com/anthropics/skills /tmp/skills-update

# 2. Replace skill contents (keep this NOTICE.md!)
cp -r /tmp/skills-update/skills/frontend-design/* skills2set/frontend-design/
# (Don't overwrite NOTICE.md — re-add this header after if needed)

# 3. Diff to spot changes
git diff skills2set/frontend-design/

# 4. Run brain regression tests before committing
npm test
```

## License Compliance

Per Apache 2.0 §4(c), we preserve the original `LICENSE.txt` in this directory.
Per §4(d), modifications (if any) are documented in commit history under
`skills2set/frontend-design/`.

No modifications have been made to upstream content as of the vendor date.
