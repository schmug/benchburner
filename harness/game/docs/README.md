# harness/game/docs/ — vendored game documentation

`basic/` holds the five **Basic Mechanics** files that go verbatim into
the orchestrator's system prompt (`BASIC_DOCS` in `../docs.ts`). They are
copied byte-for-byte from the pinned game source:

| vendored copy        | upstream path                                              |
|----------------------|------------------------------------------------------------|
| `basic/ram.md`       | `bitburner/src/src/Documentation/doc/en/basic/ram.md`      |
| `basic/servers.md`   | `bitburner/src/src/Documentation/doc/en/basic/servers.md`  |
| `basic/hacking.md`   | `bitburner/src/src/Documentation/doc/en/basic/hacking.md`  |
| `basic/scripts.md`   | `bitburner/src/src/Documentation/doc/en/basic/scripts.md`  |
| `basic/programs.md`  | `bitburner/src/src/Documentation/doc/en/basic/programs.md` |

**Provenance:** upstream commit `a4b0f22a2e5bcf19826c0bb671373c755fc162ad`
— the repo-root `BITBURNER_COMMIT` pin, i.e. the same commit every scored
run boots. Total ~18 KB.

## Why these are vendored and not read from the submodule

Checking out the submodule pulls ~316 MB of git history (plus a ~24 MB
working tree). Reading it on every pull request to get 18 KB of markdown
made `ci.yml` clone the whole thing under a `timeout-minutes: 5` budget
— a large, fragile cost for a tiny, fixed input. Since the docs are pinned to a commit anyway, **vendoring is
pinning**: the bytes in this directory are the bytes at
`BITBURNER_COMMIT`, so nothing about reproducibility or fairness changes.
CI now runs with `submodules: false` and still proves that the
orchestrator is handed the game's own text.

Only `BASIC_DOCS` is vendored. `LIBRARY_DOCS` (the tutorial and the
optimal-batching guide, pushed in-world for a subagent to fetch) is still
read straight from the submodule — the only consumer of those runs with
the game built, so the submodule is present by construction there.

## Re-vendoring when the pin moves

Whenever `BITBURNER_COMMIT` changes, re-copy in the same commit that
moves the pin, so the vendored bytes never lag the pinned game:

```sh
git submodule update --init --recursive     # needs the submodule, once
for f in ram servers hacking scripts programs; do
  cp "bitburner/src/src/Documentation/doc/en/basic/$f.md" \
     "harness/game/docs/basic/$f.md"
done
```

Then update the SHA above, and confirm the copies match the source:

```sh
for f in ram servers hacking scripts programs; do
  diff -q "harness/game/docs/basic/$f.md" \
          "bitburner/src/src/Documentation/doc/en/basic/$f.md" \
    || echo "DRIFT: $f"
done
```

The prompt text is part of the measurement: changing these files changes
what every orchestrator sees, so a re-vendor is a benchmark-affecting
change and results either side of it are not strictly comparable.
