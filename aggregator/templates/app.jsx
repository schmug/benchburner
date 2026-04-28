/* global React, ReactDOM */
const { useState, useMemo, useEffect } = React;

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────
function formatMoney(n) {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n}`;
}

function formatInt(n) {
  return n.toLocaleString("en-US");
}

function shortDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toUTCString().replace("GMT", "UTC");
}

// Produce a small SVG sparkline
function Sparkline({ points, accent, height = 28, width = 120, fill = true }) {
  if (!points?.length) return null;
  const max = Math.max(...points.map((p) => p.money)) || 1;
  const xs = (i) => (i / (points.length - 1)) * width;
  const ys = (m) => height - (m / max) * (height - 2) - 1;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${xs(i).toFixed(2)},${ys(p.money).toFixed(2)}`).join(" ");
  const area = `${d} L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
      {fill && <path d={area} fill={accent} fillOpacity="0.13" />}
      <path d={d} fill="none" stroke={accent} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width} cy={ys(points[points.length - 1].money)} r="1.8" fill={accent} />
    </svg>
  );
}

// Larger chart for expanded view
function BigChart({ points, accent, height = 200, width = 760 }) {
  const pad = { l: 56, r: 16, t: 16, b: 28 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const max = Math.max(...points.map((p) => p.money)) || 1;
  const xs = (i) => pad.l + (i / (points.length - 1)) * w;
  const ys = (m) => pad.t + h - (m / max) * h;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${xs(i).toFixed(2)},${ys(p.money).toFixed(2)}`).join(" ");
  const area = `${d} L${pad.l + w},${pad.t + h} L${pad.l},${pad.t + h} Z`;
  const yticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: pad.t + h - f * h, v: max * f }));
  const xticks = [0, 6, 12, 18, 24].map((hr) => ({ x: pad.l + (hr / 24) * w, v: hr }));
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block" }}>
      {yticks.map((t, i) => (
        <g key={i}>
          <line x1={pad.l} x2={pad.l + w} y1={t.y} y2={t.y} stroke="var(--bb-grid)" strokeDasharray="2 3" />
          <text x={pad.l - 8} y={t.y + 3} textAnchor="end" fontSize="10" fill="var(--bb-dim)" fontFamily="var(--bb-mono)">{formatMoney(t.v)}</text>
        </g>
      ))}
      {xticks.map((t, i) => (
        <g key={i}>
          <line x1={t.x} x2={t.x} y1={pad.t + h} y2={pad.t + h + 4} stroke="var(--bb-grid)" />
          <text x={t.x} y={pad.t + h + 16} textAnchor="middle" fontSize="10" fill="var(--bb-dim)" fontFamily="var(--bb-mono)">H+{t.v}</text>
        </g>
      ))}
      <path d={area} fill={accent} fillOpacity="0.12" />
      <path d={d} fill="none" stroke={accent} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      {points.filter((_, i) => i % 6 === 0 || i === points.length - 1).map((p, i) => (
        <circle key={i} cx={xs(points.indexOf(p))} cy={ys(p.money)} r="2" fill={accent} />
      ))}
    </svg>
  );
}

// Identicon-ish sigil for anonymous submissions
function Sigil({ seed, size = 22, color }) {
  const cells = [];
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (rand() > 0.55) {
        cells.push({ x, y });
        if (x < 2) cells.push({ x: 4 - x, y });
      }
    }
  }
  return (
    <svg width={size} height={size} viewBox="0 0 5 5" style={{ display: "block", borderRadius: 3 }}>
      <rect width="5" height="5" fill="var(--bb-bg-2)" />
      {cells.map((c, i) => <rect key={i} x={c.x} y={c.y} width="1" height="1" fill={color} />)}
    </svg>
  );
}

// Status pill
function StatusPill({ status }) {
  const map = {
    completed: { label: "completed", cls: "bb-pill bb-pill-ok" },
    failed: { label: "failed", cls: "bb-pill bb-pill-fail" },
    in_progress: { label: "running", cls: "bb-pill bb-pill-pending" },
  };
  const m = map[status] || { label: status, cls: "bb-pill" };
  return <span className={m.cls}>{m.label}</span>;
}

// Family/model logo square — a colored square with initials
function ModelMark({ entry, anonymousReveal }) {
  const isAnon = entry.attribution === "anonymous";
  const showReal = isAnon && anonymousReveal;
  if (isAnon && !showReal) {
    return <Sigil seed={entry.run_id} color="var(--bb-accent)" />;
  }
  const initials = entry.short_name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="bb-mark">
      <span>{initials}</span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Header
// ────────────────────────────────────────────────────────────
function Header({ meta, leader }) {
  const generatedAt = shortDate(meta.generated_at);
  const commit = meta.bitburner_commit && meta.bitburner_commit !== "unknown"
    ? `${meta.bitburner_commit.slice(0, 12)}…`
    : "unknown";
  return (
    <header className="bb-header">
      <div className="bb-header-top">
        <div className="bb-brand">
          <div className="bb-brand-mark">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect x="1.5" y="1.5" width="17" height="17" rx="2" stroke="var(--bb-fg)" strokeWidth="1.2"/>
              <path d="M5 14 L5 6 L9 6 Q11 6 11 8 Q11 10 9 10 L5 10 M9 10 Q12 10 12 12 Q12 14 9 14 Z" stroke="var(--bb-accent)" strokeWidth="1.2" fill="none"/>
            </svg>
          </div>
          <div className="bb-brand-text">
            <div className="bb-brand-name">benchburner</div>
            <div className="bb-brand-sub">orchestration benchmark · v0.1</div>
          </div>
        </div>
        <nav className="bb-nav">
          <a className="bb-nav-link bb-nav-active" href="index.html">leaderboard</a>
          <a className="bb-nav-link" href="about.html">about</a>
          <a className="bb-nav-link" href="https://github.com/schmug/benchburner">github ↗</a>
        </nav>
      </div>

      <div className="bb-hero">
        <div className="bb-hero-title">
          <h1>
            How well does an LLM <em>manage</em> a team that codes?
          </h1>
          <p className="bb-hero-sub">
            24-hour wall-clock runs. The orchestrator never plays the game and never edits subagent code —
            it only spawns, kills, and instructs. Score = total in-game money at T+24h.
          </p>
        </div>
        <div className="bb-hero-meta">
          <MetaCell label="generated" mono>{generatedAt}</MetaCell>
          <MetaCell label="bitburner" mono>{commit}</MetaCell>
          <MetaCell label="seed">
            <span className="bb-pill bb-pill-locked">SEALED</span>
            <span className="bb-meta-aside">opaque to orchestrator</span>
          </MetaCell>
          <MetaCell label="cycle">
            <span className="bb-mono">{leader ? formatInt(leader.delegations) : "—"} delegations</span>
            <span className="bb-meta-aside">in current top run</span>
          </MetaCell>
        </div>
      </div>

      <div className="bb-stats">
        <Stat k="orchestrators" v={String(meta.orchestrators_count ?? 0)} sub="ranked" />
        <Stat k="top score" v={leader ? formatMoney(leader.final_money) : "—"} sub={leader ? `by ${leader.short_name}` : "no runs yet"} accent />
        <Stat k="bitnodes cleared" v={String(leader ? leader.bitnodes_completed : 0)} sub="this cycle" />
        <Stat k="roster" v={leader && leader.roster.length ? `${leader.roster.length}` : "—"} sub="curated subagent pool" />
        <Stat k="duration" v="24h" sub="real time, no acceleration" />
      </div>
    </header>
  );
}

function MetaCell({ label, children, mono }) {
  return (
    <div className="bb-meta-cell">
      <div className="bb-meta-label">{label}</div>
      <div className={"bb-meta-value " + (mono ? "bb-mono" : "")}>{children}</div>
    </div>
  );
}

function Stat({ k, v, sub, accent }) {
  return (
    <div className={"bb-stat " + (accent ? "bb-stat-accent" : "")}>
      <div className="bb-stat-label">{k}</div>
      <div className="bb-stat-value">{v}</div>
      <div className="bb-stat-sub">{sub}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Empty state
// ────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <div className="bb-card bb-card-flat" style={{ padding: "48px 32px", textAlign: "center", marginTop: 24 }}>
      <div className="bb-card-title" style={{ marginBottom: 12 }}>no runs yet</div>
      <p style={{ color: "var(--bb-fg-soft)", margin: "0 auto", maxWidth: "52ch", fontSize: 14, lineHeight: 1.6 }}>
        The aggregator found no <span className="bb-mono">results/&lt;run_id&gt;/summary.json</span> on this branch.
        Once an orchestrator finishes a 24h cycle and its run is exported, it will appear here.
      </p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Leaderboard table
// ────────────────────────────────────────────────────────────
function Leaderboard({ entries, sortKey, setSortKey, expanded, setExpanded, showSparklines, anonymousReveal, density }) {
  const sorted = useMemo(() => {
    const arr = [...entries];
    arr.sort((a, b) => (sortKey === "rank" ? a.rank - b.rank : (b[sortKey] ?? 0) - (a[sortKey] ?? 0)));
    return arr;
  }, [entries, sortKey]);

  const SortHead = ({ k, children, align = "left" }) => (
    <th className={`bb-th bb-th-${align} ${sortKey === k ? "bb-th-active" : ""}`} onClick={() => setSortKey(k)}>
      <span>{children}</span>
      {sortKey === k && <span className="bb-th-arrow">↓</span>}
    </th>
  );

  return (
    <section className={`bb-board bb-density-${density}`}>
      <div className="bb-section-head">
        <h2>Leaderboard</h2>
        <div className="bb-section-meta">
          ranked by <span className="bb-mono">final_money</span> · all entries from the same pinned seed + roster
        </div>
      </div>

      {sorted.length === 0 ? (
        <EmptyState />
      ) : (
        <table className="bb-table">
          <thead>
            <tr>
              <th className="bb-th bb-th-num">#</th>
              <th className="bb-th">orchestrator</th>
              <SortHead k="final_money" align="right">final_money</SortHead>
              {showSparklines && <th className="bb-th bb-th-spark">trajectory</th>}
              <SortHead k="bitnodes_completed" align="right">bn</SortHead>
              <SortHead k="augments_installed" align="right">aug</SortHead>
              <SortHead k="delegations" align="right">delegations</SortHead>
              <SortHead k="scripts_run" align="right">scripts</SortHead>
              <SortHead k="tokens_used" align="right">tokens</SortHead>
              <th className="bb-th">status</th>
              <th className="bb-th bb-th-chev"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((e) => (
              <Row
                key={e.run_id}
                entry={e}
                expanded={expanded === e.run_id}
                onToggle={() => setExpanded(expanded === e.run_id ? null : e.run_id)}
                showSparklines={showSparklines}
                anonymousReveal={anonymousReveal}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Row({ entry, expanded, onToggle, showSparklines, anonymousReveal }) {
  const isAnon = entry.attribution === "anonymous";
  const displayName = isAnon && !anonymousReveal ? entry.short_name : entry.short_name;
  const family = isAnon && !anonymousReveal ? "—" : entry.family;
  return (
    <React.Fragment>
      <tr className={`bb-tr ${expanded ? "bb-tr-expanded" : ""} ${entry.status === "failed" ? "bb-tr-failed" : ""}`} onClick={onToggle}>
        <td className="bb-td bb-td-rank"><span className="bb-rank">{String(entry.rank).padStart(2, "0")}</span></td>
        <td className="bb-td">
          <div className="bb-orch">
            <ModelMark entry={entry} anonymousReveal={anonymousReveal} />
            <div className="bb-orch-text">
              <div className="bb-orch-name">{displayName}</div>
              <div className="bb-orch-sub">
                <span>{family}</span>
                <span className="bb-dot">·</span>
                <span className="bb-mono bb-dim">{entry.run_id}</span>
              </div>
            </div>
          </div>
        </td>
        <td className="bb-td bb-td-num">
          <div className="bb-money">{formatMoney(entry.final_money)}</div>
        </td>
        {showSparklines && (
          <td className="bb-td bb-td-spark">
            <Sparkline points={entry.snapshots} accent="var(--bb-accent)" />
          </td>
        )}
        <td className="bb-td bb-td-num"><span className={entry.bitnodes_completed > 0 ? "bb-bn-yes" : "bb-bn-no"}>{entry.bitnodes_completed}</span></td>
        <td className="bb-td bb-td-num bb-mono bb-dim">{entry.augments_installed}</td>
        <td className="bb-td bb-td-num bb-mono">{formatInt(entry.delegations)}</td>
        <td className="bb-td bb-td-num bb-mono bb-dim">{formatInt(entry.scripts_run)}</td>
        <td className="bb-td bb-td-num bb-mono bb-dim">{(entry.tokens_used / 1e6).toFixed(2)}M</td>
        <td className="bb-td"><StatusPill status={entry.status} /></td>
        <td className="bb-td bb-td-chev">
          <span className={`bb-chev ${expanded ? "bb-chev-open" : ""}`}>›</span>
        </td>
      </tr>
      {expanded && (
        <tr className="bb-tr-detail">
          <td colSpan={showSparklines ? 11 : 10}>
            <RunDetail entry={entry} />
          </td>
        </tr>
      )}
    </React.Fragment>
  );
}

// ────────────────────────────────────────────────────────────
// Run detail (inline, expanded row)
// ────────────────────────────────────────────────────────────
function RunDetail({ entry }) {
  const runUrl = `runs/${entry.run_id}/`;
  const delegations = entry.delegations_sample || [];
  const sampleScript = entry.script_sample || "// no committed scripts captured for this run";
  return (
    <div className="bb-detail">
      <div className="bb-detail-head">
        <div>
          <div className="bb-detail-eyebrow">RUN · {entry.run_id}</div>
          <div className="bb-detail-title">{entry.short_name}</div>
          {entry.notes && <div className="bb-detail-note">// {entry.notes}</div>}
          {entry.failure_reason && (
            <div className="bb-detail-fail">! {entry.failure_reason}</div>
          )}
        </div>
        <div className="bb-detail-actions">
          <a className="bb-link-btn" href={`${runUrl}summary.json`}>summary.json ↗</a>
          <a className="bb-link-btn" href={`${runUrl}delegations.json`}>delegations.json ↗</a>
          <a className="bb-link-btn" href={`${runUrl}scripts.json`}>scripts.json ↗</a>
          <a className="bb-link-btn bb-link-btn-primary" href={runUrl}>open run page →</a>
        </div>
      </div>

      <div className="bb-detail-grid">
        <div className="bb-card bb-card-chart">
          <div className="bb-card-head">
            <div className="bb-card-title">money over time</div>
            <div className="bb-card-meta">{entry.snapshots.length} hourly snapshots · final {formatMoney(entry.final_money)}</div>
          </div>
          {entry.snapshots.length > 0
            ? <BigChart points={entry.snapshots} accent="var(--bb-accent)" />
            : <div className="bb-dim bb-mono" style={{ padding: 24, fontSize: 12 }}>no snapshots captured</div>}
        </div>

        <div className="bb-card bb-card-stats">
          <div className="bb-card-head"><div className="bb-card-title">team composition</div></div>
          {entry.roster.length > 0 ? (
            <ul className="bb-roster">
              {entry.roster.map((r, i) => (
                <li key={i} className="bb-roster-item">
                  <span className="bb-roster-dot" />
                  <span className="bb-mono">{r}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="bb-dim bb-mono" style={{ paddingBottom: 12, fontSize: 11 }}>roster not recorded</div>
          )}
          <div className="bb-kvs">
            <KV k="delegations" v={formatInt(entry.delegations)} />
            <KV k="scripts run" v={formatInt(entry.scripts_run)} />
            <KV k="subagent errors" v={String(entry.subagent_errors)} bad={entry.subagent_errors > 30} />
            <KV k="tokens used" v={`${(entry.tokens_used / 1e6).toFixed(2)}M`} />
            <KV k="duration" v={`${entry.duration_hours}h`} />
          </div>
        </div>

        <div className="bb-card bb-card-timeline">
          <div className="bb-card-head">
            <div className="bb-card-title">delegation transcript</div>
            <div className="bb-card-meta">first {delegations.length} events · the orchestrator only sees what subagents report</div>
          </div>
          {delegations.length > 0 ? (
            <ol className="bb-timeline">
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
        </div>

        <div className="bb-card bb-card-script">
          <div className="bb-card-head">
            <div className="bb-card-title">sample committed script</div>
            <div className="bb-card-meta">{entry.roster[0] || "—"}</div>
          </div>
          <pre className="bb-code"><code>{sampleScript}</code></pre>
        </div>
      </div>
    </div>
  );
}

function KV({ k, v, bad }) {
  return (
    <div className={`bb-kv ${bad ? "bb-kv-bad" : ""}`}>
      <span className="bb-kv-k">{k}</span>
      <span className="bb-kv-v bb-mono">{v}</span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// App
// ────────────────────────────────────────────────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "accent": "amber",
  "density": "comfortable",
  "showSparklines": true,
  "anonymousReveal": false
}/*EDITMODE-END*/;

const ACCENT_MAP = {
  amber: { c: "#ffb454", glow: "rgba(255,180,84,0.18)" },
  cyan: { c: "#7adcff", glow: "rgba(122,220,255,0.18)" },
  green: { c: "#86e58a", glow: "rgba(134,229,138,0.18)" },
  magenta: { c: "#f0a3ff", glow: "rgba(240,163,255,0.18)" },
};

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [sortKey, setSortKey] = useState("final_money");
  const data = window.BB_DATA;
  const [expanded, setExpanded] = useState(data.entries[0]?.run_id ?? null);

  const leader = data.entries[0] ?? null;

  // Apply theme + accent vars
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.bbTheme = t.theme;
    const accentName = t.theme === "terminal" ? "green" : t.accent;
    const accent = ACCENT_MAP[accentName] || ACCENT_MAP.amber;
    root.style.setProperty("--bb-accent", accent.c);
    root.style.setProperty("--bb-accent-glow", accent.glow);
  }, [t.theme, t.accent]);

  return (
    <div className="bb-root">
      <div className="bb-grain" aria-hidden="true" />
      <div className="bb-container">
        <Header meta={data.meta} leader={leader} />
        <Leaderboard
          entries={data.entries}
          sortKey={sortKey}
          setSortKey={setSortKey}
          expanded={expanded}
          setExpanded={setExpanded}
          showSparklines={t.showSparklines}
          anonymousReveal={t.anonymousReveal}
          density={t.density}
        />
        <Footer />
      </div>

      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakRadio label="Mode" value={t.theme} options={["dark", "terminal", "light"]}
          onChange={(v) => setTweak("theme", v)} />
        <TweakSelect label="Accent" value={t.accent} options={["amber", "cyan", "green", "magenta"]}
          onChange={(v) => setTweak("accent", v)} />

        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density} options={["compact", "comfortable"]}
          onChange={(v) => setTweak("density", v)} />
        <TweakToggle label="Show sparklines" value={t.showSparklines}
          onChange={(v) => setTweak("showSparklines", v)} />

        <TweakSection label="Privacy" />
        <TweakToggle label="Reveal anonymous submissions" value={t.anonymousReveal}
          onChange={(v) => setTweak("anonymousReveal", v)} />
      </TweaksPanel>
    </div>
  );
}

function Footer() {
  return (
    <footer className="bb-footer">
      <div className="bb-footer-grid">
        <div>
          <div className="bb-foot-eyebrow">about</div>
          <p>
            benchburner is a public benchmark for the orchestration capability of LLMs.
            Each model directs a team of subagent coders that play a pinned, headless
            instance of an open-source idle game for 24 wall-clock hours. The orchestrator
            never touches code or game state directly.
          </p>
        </div>
        <div>
          <div className="bb-foot-eyebrow">reproducibility</div>
          <ul className="bb-foot-list">
            <li><span className="bb-mono bb-dim">seed</span> pinned, opaque to the orchestrator</li>
            <li><span className="bb-mono bb-dim">commit</span> game forked + locked per cycle</li>
            <li><span className="bb-mono bb-dim">roster</span> identical curated pool of subagents</li>
            <li><span className="bb-mono bb-dim">prompt</span> fixed system prompt across all entrants</li>
          </ul>
        </div>
        <div>
          <div className="bb-foot-eyebrow">artifacts</div>
          <ul className="bb-foot-list">
            <li><a className="bb-mono" href="leaderboard.json">leaderboard.json ↗</a></li>
            <li><a className="bb-mono" href="https://github.com/schmug/benchburner/branches">orchestrator/&lt;model&gt; branches ↗</a></li>
            <li><a className="bb-mono" href="https://github.com/schmug/benchburner/blob/main/SPEC.md">SPEC.md ↗</a></li>
          </ul>
        </div>
      </div>
      <div className="bb-foot-bottom">
        <div>© 2026 benchburner · MIT (pending)</div>
        <div className="bb-mono bb-dim">build {new Date().getFullYear()}.04 · static · no telemetry</div>
      </div>
    </footer>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
