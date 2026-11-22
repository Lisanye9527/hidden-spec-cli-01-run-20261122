# mend

One patch tool for every AI edit format, built for [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

AI models write edits in four formats; `mend` reads all of them to one written
contract (`SPEC.md`) and applies them to a tree of text files — every change
or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- Formats: unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edit
  calls. `--format` names one; the default `auto` detects it.
- Lines an edit names are found at the first of three matching tiers: exact,
  trailing-whitespace-insensitive, then fully whitespace-trimmed (tier 2
  re-indents replacement lines to the file's own indentation). `--strict`
  keeps only the exact tier.
- `--check` reports what would change without writing anything.
- On success it prints one `A` / `D` / `M` / `R` line per changed path and an
  `ok:` summary; on failure it prints one `error:` line per failed edit and
  writes nothing.

Node 22, standard library only. `check.ts` runs the public practice set:

    node check.ts <practice.json>

`runner.ts` is the trial runner: when `MAKEFUN_ENV_URL` is set, `main.ts`
hands over to it. MIT licensed (see `LICENSE`).
