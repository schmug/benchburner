/* global React, ReactDOM */
const { useState } = React;

// ────────────────────────────────────────────────────────────
// Run Detail — pages/runs/<run_id>/index.html
//
// Resolves the run from window.BB_RUN_ID (injected by the
// aggregator into the per-run HTML shell) against the global
// BB_DATA entries. Falls back to entries[0] for previewing.
// ────────────────────────────────────────────────────────────

function fmtMoney(n) {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n}`;
}
const fmtInt = (n) => n.toLocaleString("en-US");

const DATA = window.BB_DATA;
const META = DATA.meta;
const RUN_ID = window.BB_RUN_ID || DATA.entries[0]?.run_id;
const RUN = DATA.entries.find((e) => e.run_id === RUN_ID) || DATA.entries[0];

function MissingRun() {
  return (
    <div className="bb-root">
      <div className="bb-container">
        <header className="bb-header"><div className="bb-header-top">
          <div className="bb-brand"><div className="bb-brand-text">
            <div className="bb-brand-name">benchburner</div>
            <div className="bb-brand-sub">run not found</div>
          </div></div>
          <nav className="bb-nav"><a className="bb-nav-link" href="../../index.html">leaderboard</a></nav>
        </div></header>
        <div className="bb-card bb-card-flat" style={{ padding: 48, textAlign: "center", marginTop: 24 }}>
          <div className="bb-card-title">no run data</div>
          <p style={{ color: "var(--bb-fg-soft)" }}>
            The aggregator has no record of run <span className="bb-mono">{RUN_ID || "(unknown)"}</span>.
          </p>
        </div>
      </div>
    </div>
  );
}

// Big chart with augment markers if any are reported on the entry
function BigChart({ points, augmentHours, accent = "var(--bb-accent)", height = 240, width = 1100 }) {
  if (!points.length) return <div className="bb-dim bb-mono" style={{ padding: 24 }}>no snapshots</div>;
  const pad = { l: 64, r: 24, t: 20, b: 32 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const max = Math.max(...points.map((p) => p.money)) || 1;
  const xs = (i) => pad.l + (i / Math.max(points.length - 1, 1)) * w;
  const ys = (m) => pad.t + h - (m / max) * h;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${xs(i).toFixed(2)},${ys(p.money).toFixed(2)}`).join(" ");
  const area = `${d} L${pad.l + w},${pad.t + h} L${pad.l},${pad.t + h} Z`;
  const yticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: pad.t + h - f * h, v: max * f }));
  const xticks = [0, 4, 8, 12, 16, 20, 24].map((hr) => ({ x: pad.l + (hr / 24) * w, v: hr }));
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block" }}>
      {yticks.map((t, i) => (
        <g key={i}>
          <line x1={pad.l} x2={pad.l + w} y1={t.y} y2={t.y} stroke="var(--bb-grid)" strokeDasharray="2 3" />
          <text x={pad.l - 10} y={t.y + 3} textAnchor="end" fontSize="10" fill="var(--bb-dim)" fontFamily="var(--bb-mono)">{fmtMoney(t.v)}</text>
        </g>
      ))}
      {xticks.map((t, i) => (
        <g key={i}>
          <line x1={t.x} x2={t.x} y1={pad.t + h} y2={pad.t + h + 4} stroke="var(--bb-grid)" />
          <text x={t.x} y={pad.t + h + 18} textAnchor="middle" fontSize="10" fill="var(--bb-dim)" fontFamily="var(--bb-mono)">H+{t.v}</text>
        </g>
      ))}
      <path d={area} fill={accent} fillOpacity="0.13" />
      <path d={d} fill="none" stroke={accent} strokeWidth="1.6" strokeLinejoin="round" />
      {augmentHours.filter((hr) => hr < points.length).map((hr, i) => (
        <g key={`a${i}`}>
          <line x1={xs(hr)} x2={xs(hr)} y1={pad.t} y2={pad.t + h} stroke="var(--bb-accent)" strokeOpacity="0.18" strokeDasharray="2 4" />
          <circle cx={xs(hr)} cy={ys(points[hr].money)} r="3" fill="var(--bb-bg)" stroke={accent} strokeWidth="1.5" />
        </g>
      ))}
    </svg>
  );
}

function SubagentStripe({ tracks }) {
  if (!tracks.length) {
    return <div className="bb-dim bb-mono" style={{ padding: 12, fontSize: 11 }}>no subagent activity recorded</div>;
  }
  return (
    <div className="bb-stripe">
      {tracks.map((s) => (
        <div className="bb-stripe-row" key={s.id}>
          <div className="bb-stripe-label bb-mono">{s.id}</div>
          <div className="bb-stripe-track">
            {s.spans.map(([a, b], i) => (
              <div
                key={i}
                className="bb-stripe-bar"
                style={{ left: `${(a / 24) * 100}%`, width: `${((b - a) / 24) * 100}%` }}
              />
            ))}
            {s.killedAt != null && (
              <div className="bb-stripe-kill" style={{ left: `${(s.killedAt / 24) * 100}%` }} title={`killed at H+${s.killedAt}`}>×</div>
            )}
          </div>
          <div className="bb-stripe-count bb-mono">{s.scripts} scripts</div>
        </div>
      ))}
      <div className="bb-stripe-axis">
        {[0, 4, 8, 12, 16, 20, 24].map((h) => (
          <span key={h} style={{ left: `${(h / 24) * 100}%` }} className="bb-mono">H+{h}</span>
        ))}
      </div>
    </div>
  );
}

function RunPage() {
  if (!RUN) return <MissingRun />;

  const [tab, setTab] = useState("transcript");
  const delegations = RUN.delegations_sample || [];
  const sampleScript = RUN.script_sample;
  const augmentHours = RUN.augment_hours || [];
  const tracks = RUN.subagent_tracks || RUN.roster.map((id) => ({
    id,
    spans: [[0, RUN.duration_hours]],
    scripts: 0,
  }));

  const statusCls =
    RUN.status === "completed" ? "bb-pill bb-pill-ok" :
    RUN.status === "failed" ? "bb-pill bb-pill-fail" :
    "bb-pill bb-pill-pending";

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
              <a className="bb-nav-link" href="../../index.html">leaderboard</a>
              <a className="bb-nav-link" href="../../about.html">about</a>
              <a className="bb-nav-link" href="https://github.com/schmug/benchburner">github ↗</a>
            </nav>
          </div>

          <div className="bb-crumbs bb-mono">
            <a href="../../index.html">leaderboard</a>
            <span className="bb-crumb-sep">/</span>
            <span data-bb-field="run_id" className="bb-fg">{RUN.run_id}</span>
          </div>

          <div className="bb-runhero">
            <div className="bb-runhero-left">
              <div className="bb-runhero-rank bb-mono">RANK <span className="bb-accent" data-bb-field="rank">#{String(RUN.rank).padStart(2, "0")}</span></div>
              <h1 className="bb-runhero-title" data-bb-field="orchestrator_model">{RUN.short_name}</h1>
              <div className="bb-runhero-sub bb-mono">
                <span data-bb-field="family">{RUN.family}</span>
                <span className="bb-crumb-sep">·</span>
                <span data-bb-field="orchestrator_model_id" className="bb-dim">{RUN.orchestrator_model}</span>
              </div>
              {RUN.notes && <p className="bb-runhero-note" data-bb-field="notes">// {RUN.notes}</p>}
              {RUN.failure_reason && <p className="bb-runhero-note" style={{ color: "var(--bb-fail)" }}>! {RUN.failure_reason}</p>}
            </div>
            <div className="bb-runhero-right">
              <div className="bb-runhero-money">
                <div className="bb-runhero-money-label bb-mono">FINAL · MONEY</div>
                <div className="bb-runhero-money-value" data-bb-field="final_money">{fmtMoney(RUN.final_money)}</div>
                <div className="bb-runhero-money-sub bb-mono">
                  <span data-bb-field="bitnodes_completed">{RUN.bitnodes_completed}</span> bitnodes ·
                  <span data-bb-field="augments_installed"> {RUN.augments_installed}</span> augments
                </div>
              </div>
            </div>
          </div>

          <div className="bb-stats">
            <Stat k="status"      v={<span className={statusCls} data-bb-field="status">{RUN.status}</span>} />
            <Stat k="duration"    v={<span data-bb-field="duration_hours">{RUN.duration_hours}h</span>} />
            <Stat k="delegations" v={<span data-bb-field="delegations">{fmtInt(RUN.delegations)}</span>} />
            <Stat k="scripts run" v={<span data-bb-field="scripts_run">{fmtInt(RUN.scripts_run)}</span>} />
            <Stat k="errors"      v={<span data-bb-field="subagent_errors">{RUN.subagent_errors}</span>} />
            <Stat k="tokens"      v={<span data-bb-field="tokens_used">{(RUN.tokens_used / 1e6).toFixed(2)}M</span>} />
          </div>
        </header>

        <section className="bb-section">
          <div className="bb-section-head">
            <h2>money over time</h2>
            <div className="bb-section-meta bb-mono">{RUN.snapshots.length} hourly snapshots{augmentHours.length ? " · markers = augment installs" : ""}</div>
          </div>
          <div className="bb-card bb-card-flat">
            <BigChart points={RUN.snapshots} augmentHours={augmentHours} />
          </div>
        </section>

        <section className="bb-section">
          <div className="bb-section-head">
            <h2>subagent activity</h2>
            <div className="bb-section-meta bb-mono">spawn → kill timeline · script counts per agent</div>
          </div>
          <div className="bb-card bb-card-flat">
            <SubagentStripe tracks={tracks} />
          </div>
        </section>

        <section className="bb-section">
          <div className="bb-section-head">
            <h2>artifact transcript</h2>
            <div className="bb-tabs">
              <button className={"bb-tab " + (tab === "transcript" ? "bb-tab-on" : "")} onClick={() => setTab("transcript")}>delegations</button>
              <button className={"bb-tab " + (tab === "scripts" ? "bb-tab-on" : "")} onClick={() => setTab("scripts")}>scripts</button>
              <button className={"bb-tab " + (tab === "snapshots" ? "bb-tab-on" : "")} onClick={() => setTab("snapshots")}>snapshots</button>
              <button className={"bb-tab " + (tab === "raw" ? "bb-tab-on" : "")} onClick={() => setTab("raw")}>raw json</button>
            </div>
          </div>

          {tab === "transcript" && (
            <div className="bb-card bb-card-flat">
              {delegations.length > 0 ? (
                <ol className="bb-timeline" data-bb-field="delegations">
                  {delegations.map((d, i) => (
                    <li key={i} className={`bb-tl-item bb-tl-${d.action}`}>
                      <span className="bb-tl-time bb-mono">{d.t}</span>
                      <span className="bb-tl-action">{d.action}</span>
                      <span className="bb-tl-sub bb-mono">{d.subagent}</span>
                      <span className={`bb-tl-note ${d.ok === false ? "bb-tl-bad" : ""}`}>{d.note}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="bb-dim bb-mono" style={{ padding: 12, fontSize: 11 }}>no delegations recorded</div>
              )}
              <div className="bb-pagination bb-mono">
                showing {delegations.length} of <span data-bb-field="delegations_total">{fmtInt(RUN.delegations)}</span> ·
                <a href="delegations.json" data-bb-field="delegations_url"> delegations.json ↗</a>
              </div>
            </div>
          )}

          {tab === "scripts" && (
            <div className="bb-card bb-card-flat">
              {sampleScript ? (
                <>
                  <div className="bb-script-head bb-mono">
                    <span>{RUN.roster[0] || "subagent"}</span>
                    <span className="bb-pill bb-pill-ok" style={{ marginLeft: "auto" }}>committed sample</span>
                  </div>
                  <pre className="bb-code" data-bb-field="sample_script"><code>{sampleScript}</code></pre>
                </>
              ) : (
                <div className="bb-dim bb-mono" style={{ padding: 12, fontSize: 11 }}>no scripts captured</div>
              )}
              <div className="bb-pagination bb-mono">
                <span>1 of <span data-bb-field="scripts_total">{fmtInt(RUN.scripts_run)}</span> committed scripts</span>
                <a href="scripts.json" data-bb-field="scripts_url"> scripts.json ↗</a>
              </div>
            </div>
          )}

          {tab === "snapshots" && (
            <div className="bb-card bb-card-flat">
              {RUN.snapshots.length > 0 ? (
                <table className="bb-mini-table">
                  <thead>
                    <tr>
                      <th>hour</th><th>current_money</th><th>delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RUN.snapshots.map((s, i, arr) => {
                      const prev = i > 0 ? arr[i - 1].money : 0;
                      const delta = s.money - prev;
                      return (
                        <tr key={s.hour}>
                          <td className="bb-mono">H+{String(s.hour).padStart(2, "0")}</td>
                          <td className="bb-mono">{fmtMoney(s.money)}</td>
                          <td className={"bb-mono " + (delta > 0 ? "bb-fg-ok" : "bb-dim")}>
                            {i === 0 ? "—" : (delta > 0 ? "+" : "") + fmtMoney(delta)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="bb-dim bb-mono" style={{ padding: 12, fontSize: 11 }}>no snapshots captured</div>
              )}
            </div>
          )}

          {tab === "raw" && (
            <div className="bb-card bb-card-flat">
              <div className="bb-raw-grid">
                {[
                  { name: "summary.json", desc: "final stats + run metadata" },
                  { name: "delegations.json", desc: "every instruction + every result" },
                  { name: "scripts.json", desc: "all subagent-generated Netscript code" },
                  { name: "snapshots.json", desc: "hourly game-state snapshots" },
                ].map((f) => (
                  <a className="bb-raw-card" href={f.name} key={f.name}>
                    <div className="bb-raw-name bb-mono">{f.name}</div>
                    <div className="bb-raw-desc">{f.desc}</div>
                    <div className="bb-raw-size bb-mono">↗</div>
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="bb-section">
          <div className="bb-section-head">
            <h2>reproducibility</h2>
          </div>
          <div className="bb-repro">
            <div className="bb-repro-row">
              <span className="bb-repro-k bb-mono">bitburner_commit</span>
              <span className="bb-repro-v bb-mono" data-bb-field="bitburner_commit">{RUN.bitburner_commit || META.bitburner_commit}</span>
            </div>
            {META.seed_hash && (
              <div className="bb-repro-row">
                <span className="bb-repro-k bb-mono">seed_hash</span>
                <span className="bb-repro-v bb-mono" data-bb-field="seed_hash">{META.seed_hash}</span>
              </div>
            )}
            <div className="bb-repro-row">
              <span className="bb-repro-k bb-mono">orchestrator_branch</span>
              <span className="bb-repro-v bb-mono">{RUN.branch || `orchestrator/${RUN.orchestrator_model.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}</span>
            </div>
            <div className="bb-repro-row">
              <span className="bb-repro-k bb-mono">subagent_roster</span>
              <span className="bb-repro-v bb-mono" data-bb-field="roster">[ {RUN.roster.join(", ") || "—"} ]</span>
            </div>
            {RUN.start_time && (
              <div className="bb-repro-row">
                <span className="bb-repro-k bb-mono">start_time</span>
                <span className="bb-repro-v bb-mono">{RUN.start_time}</span>
              </div>
            )}
          </div>
        </section>

        <div className="bb-pagenav">
          <a className="bb-link-btn" href="../../index.html">← back to leaderboard</a>
          <a className="bb-link-btn bb-link-btn-primary" href="../../about.html">methodology →</a>
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v }) {
  return (
    <div className="bb-stat">
      <div className="bb-stat-label">{k}</div>
      <div className="bb-stat-value bb-stat-value-sm">{v}</div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<RunPage />);
