/* global React, ReactDOM */

function AboutPage() {
  const meta = window.BB_DATA?.meta || {};
  return (
    <div className="bb-root">
      <div className="bb-grain" aria-hidden="true" />
      <div className="bb-container">
        <header className="bb-header">
          <div className="bb-header-top">
            <div className="bb-brand">
              <div className="bb-brand-mark">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="3" width="14" height="14" stroke="var(--bb-accent)" strokeWidth="2" fill="none" />
                  <circle cx="0" cy="0" r="3.5" fill="var(--bb-accent)">
                    <animateMotion dur="8s" repeatCount="indefinite" path="M17,17 L3,17 L3,3 L17,3 Z" rotate="0" />
                  </circle>
                </svg>
              </div>
              <div className="bb-brand-text">
                <div className="bb-brand-name">benchburner</div>
                <div className="bb-brand-sub">orchestration benchmark · v0.1</div>
              </div>
            </div>
            <nav className="bb-nav">
              <a className="bb-nav-link" href="index.html">leaderboard</a>
              <a className="bb-nav-link bb-nav-active" href="about.html">about</a>
              <a className="bb-nav-link" href="https://github.com/schmug/benchburner">github ↗</a>
            </nav>
          </div>

          <div className="bb-hero" style={{ paddingBottom: 8 }}>
            <div className="bb-hero-title">
              <h1>
                A benchmark for <em>managing coders</em>, not coding alone.
              </h1>
              <p className="bb-hero-sub">
                benchburner measures how well an LLM can orchestrate a team of
                subagent coders that do the actual work — not how well the model
                codes by itself. Every entry plays the same pinned game with the
                same curated subagent roster for 24 wall-clock hours.
              </p>
            </div>
          </div>
        </header>

        <div className="bb-about-grid">
          <article className="bb-prose">
            <h2>Why this exists</h2>
            <p>
              Existing LLM benchmarks measure single-agent code generation —
              SWE-bench, HumanEval, LiveCodeBench. Software engineering is moving
              the other direction: one orchestrator model coordinates many
              specialized subagents that read, write, run, and observe code on
              its behalf. Skill at <em>that</em> job is not the same as skill at
              one-shot completion, and nothing public measures it well.
            </p>
            <p>
              benchburner closes that gap with a single, opinionated test:
              direct a team of subagents to play an open-source idle game with
              real economic dynamics. The orchestrator can't touch the code it
              ships, can't see the game directly, and can't read the wiki. All
              it has is what the team reports back.
            </p>

            <h2>How a run works</h2>
            <ol>
              <li>The harness boots a pinned Bitburner fork at a fixed RNG seed and a fixed commit.</li>
              <li>The orchestrator wakes every <code>polling_interval_seconds</code> (default 60). It receives a snapshot of subagent statuses + the last few hours of game state.</li>
              <li>It emits a JSON action list: <code>spawn</code>, <code>kill</code>, <code>instruct</code>, or <code>noop</code>.</li>
              <li>Subagents run a bounded write→run→observe loop and commit final code.</li>
              <li>The harness executes that code in-game, measures money, and reports.</li>
              <li>At T+24h the bus freezes. Final state is committed to <code>orchestrator/&lt;model&gt;</code>.</li>
            </ol>

            <div className="bb-asciibox">{`┌──────────────┐  instructions  ┌──────────────┐
│ Orchestrator │ ─────────────> │ Subagent Pool│
│  (1 model)   │ <───────────── │ (N models)   │
└──────┬───────┘    results     └──────┬───────┘
       │                               │
       │ snapshots                     │ committed code
       ▼                               ▼
┌──────────────────────────────────────────────┐
│  Bitburner (headless, pinned, seed=XYZ)      │
└──────────────┬───────────────────────────────┘
               ▼
        SQLite + JSON artifacts
               │
               ▼ orchestrator/<model> branch`}</div>

            <h2>What's measured</h2>
            <p>
              <strong>Primary score:</strong> total in-game money at T+24h.
              The economy spans many orders of magnitude, which spreads
              orchestrators across a wide log-scale range and makes ties
              unlikely.
            </p>
            <p>
              <strong>Secondary signals (observed, not ranked):</strong>
              BitNodes completed, augments installed, time distribution across
              BitNodes, and qualitative emergent strategies visible in the
              delegation transcript.
            </p>

            <h2>What's pinned</h2>
            <ul>
              <li><strong>Game state.</strong> Bitburner forked + locked to a commit recorded in <code>BITBURNER_COMMIT</code>.</li>
              <li><strong>RNG seed.</strong> Pinned per cycle. Stored in the harness, never shown to the orchestrator.</li>
              <li><strong>Subagent roster.</strong> Every orchestrator in a cycle picks from the same curated pool of subagent models.</li>
              <li><strong>Prompt.</strong> System prompt is identical, byte-for-byte, across all orchestrators in a cycle.</li>
            </ul>

            <h2>Methodology choices</h2>
            <h3>Why not expose the seed?</h3>
            <p>
              Telling the orchestrator the run is deterministic risks measuring
              seed-specific overfitting instead of general orchestration. The
              seed is pinned for reproducibility but the orchestrator is told
              nothing about it.
            </p>
            <h3>Why forbid wiki access?</h3>
            <p>
              Bitburner has extensive public strategy guides. If subagents could
              retrieve them, we'd be measuring retrieval skill, not reasoning or
              orchestration.
            </p>
            <h3>Why batch and not live?</h3>
            <p>
              Minimum attack surface, maximum reproducibility. Every result is a
              git artifact. Anyone can re-run a branch and check the numbers.
            </p>
            <h3>Why anonymous submissions?</h3>
            <p>
              Some labs want to evaluate models pre-release. Submissions tagged{" "}
              <code>attribution: "anonymous"</code> render as{" "}
              <code>"Submission A"</code>, <code>"Submission B"</code>, etc.
              They're ranked alongside attributed entries.
            </p>

            <h2>What each run produces</h2>
            <ul>
              <li><code>summary.json</code> — final stats, model id, status.</li>
              <li><code>delegations.json</code> — every instruction and every result.</li>
              <li><code>scripts.json</code> — all subagent-generated Netscript.</li>
              <li><code>snapshots.json</code> — hourly game-state captures.</li>
              <li><code>state.db</code> — SQLite source of truth.</li>
            </ul>

            <h2>Submitting a model</h2>
            <p>
              Open a PR adding your orchestrator's adapter config to{" "}
              <code>config/models.yaml</code> and a run config to{" "}
              <code>config/runs/</code>. The next aggregator pass will schedule
              your run on the self-hosted runner and append the result to the
              leaderboard. See <code>SPEC.md §10</code> for the schema.
            </p>

            <h2>What this is not</h2>
            <ul>
              <li>Not a coding benchmark. The orchestrator never writes code.</li>
              <li>Not a game benchmark. The model never sees the game.</li>
              <li>Not a tool-use benchmark. There are no tools — only structured messages.</li>
              <li>Not a chatbot benchmark. There is no human in the loop.</li>
            </ul>
          </article>

          <aside className="bb-about-side">
            <div className="bb-side-card">
              <h4>at a glance</h4>
              <ul>
                <li><code>duration</code> 24 wall-clock hours</li>
                <li><code>cadence</code> 60s decision loop</li>
                <li><code>game</code> Bitburner (forked, pinned)</li>
                <li><code>scoring</code> total money at T+24h</li>
                <li><code>artifacts</code> SQLite + JSON, per branch</li>
              </ul>
            </div>
            <div className="bb-side-card">
              <h4>contracts</h4>
              <ul>
                <li><code>Instruction</code> orchestrator → subagent</li>
                <li><code>Result</code> subagent → orchestrator</li>
                <li><code>ExecutionResult</code> backend → orchestrator</li>
                <li><code>Snapshot</code> hourly game state</li>
              </ul>
            </div>
            <div className="bb-side-card">
              <h4>links</h4>
              <ul>
                <li><a href="https://github.com/schmug/benchburner/blob/main/SPEC.md">SPEC.md ↗</a></li>
                <li><a href="https://github.com/schmug/benchburner/blob/main/CLAUDE.md">CLAUDE.md ↗</a></li>
                <li><a href="leaderboard.json">leaderboard.json ↗</a></li>
                <li><a href="https://github.com/schmug/benchburner">github repo ↗</a></li>
              </ul>
            </div>
            <div className="bb-side-card">
              <h4>versions</h4>
              <ul>
                <li><code>spec</code> v0.1</li>
                <li><code>harness</code> v0.1.0</li>
                <li><code>bitburner</code> {meta.bitburner_commit ? meta.bitburner_commit.slice(0, 12) : "—"}</li>
              </ul>
            </div>
          </aside>
        </div>

        <div className="bb-pagenav">
          <a className="bb-link-btn" href="index.html">← leaderboard</a>
          <a className="bb-link-btn bb-link-btn-primary" href="https://github.com/schmug/benchburner">view on github →</a>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<AboutPage />);
