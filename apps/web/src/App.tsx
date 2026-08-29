import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import { contributions, contributionSummary } from "./contributions";
import type { Agent, AgentRun, Capability, IngressDecision, Message, PromptScreen, RunEvidence, StopReason, SystemInfo, TrifectaDecision } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function formatBytes(value: number): string {
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return Math.round(value / 1024) + " KiB";
  return (value / (1024 * 1024)).toFixed(1) + " MiB";
}

const STOP_REASON_LABEL: Record<StopReason, string> = {
  "name-only": "settled from the file name, never opened",
  "metadata-only": "settled from document properties, body never decompressed",
  signal: "stopped at the first signal",
  budget: "stopped at the inspection budget",
  complete: "read in full",
};

const CAPABILITY_LABEL: Record<Capability, string> = {
  "private-data": "Private data",
  "untrusted-content": "Untrusted content",
  "external-comms": "External comms",
};

/**
 * The lethal trifecta, drawn as three legs rather than described as a rule.
 * Holding any two is ordinary; holding all three is what makes an agent
 * dangerous, so the panel shows which legs this Run held and which one the gate
 * removed.
 */
function Trifecta({ trifecta }: { trifecta: TrifectaDecision }) {
  return (
    <div className={"trifecta trifecta-" + trifecta.outcome}>
      <div className="trifecta-head">
        <span className="eyebrow">Lethal trifecta</span>
        <span className={"trifecta-state state-" + trifecta.outcome}>
          {trifecta.outcome === "safe" ? trifecta.present.length + " of 3 held" : trifecta.outcome === "mitigated" ? "broken" : "unmitigated"}
        </span>
      </div>
      <ul className="trifecta-legs">
        {trifecta.findings.map((finding) => {
          const dropped = trifecta.outcome === "mitigated" && finding.capability === "private-data";
          return (
            <li key={finding.capability} className={(finding.present ? "leg-held" : "leg-clear") + (dropped ? " leg-dropped" : "")}>
              <span className="leg-dot" aria-hidden="true" />
              <span className="leg-name">{CAPABILITY_LABEL[finding.capability]}</span>
              <span className="leg-reason">{finding.reason}</span>
            </li>
          );
        })}
      </ul>
      {trifecta.mitigation && <p className="trifecta-mitigation">{trifecta.mitigation}. The Run keeps running; it just cannot read private material while it also holds untrusted content and network reach.</p>}
      {trifecta.outcome === "unmitigated" && <p className="trifecta-mitigation">All three capabilities were held. The gate is in audit mode, so this was recorded rather than mitigated.</p>}
    </div>
  );
}

/**
 * The read-side half of the evidence panel. The numbers matter more than the
 * prose here: a reviewer should be able to see how little of each file the gate
 * had to read before it decided, and which half of the gate decided it.
 */
function IngressGate({ ingress, promptScreen, activeContribution, onHoverSurface }: { ingress: IngressDecision; promptScreen: PromptScreen | null; activeContribution: number | null; onHoverSurface: (id: number | null) => void }) {
  const promptFindings = [
    promptScreen?.outcome === "sanitized" ? { id: "IN010", text: "Credential material was stripped from the prompt before anything was staged." } : null,
    promptScreen?.requestsSensitiveAccess ? { id: "IN011", text: "This request asks the Agent to read or transmit sensitive material." } : null,
    ...ingress.adjudications
      .filter((record) => record.kind === "prompt" && record.raised)
      .map((record) => ({ id: "IN041", text: record.rationale || "The adjudicator judged this request to need material above clearance." })),
  ].filter((finding): finding is { id: string; text: string } => finding !== null);
  const judged = ingress.adjudications.filter((record) => record.kind === "file");

  return (
    <div className="ingress-gate">
      <div className="ingress-head">
        <div>
          <span className="eyebrow">Ingress gate</span>
          <h4>What the Runtime was allowed to read</h4>
        </div>
        <span className={"ingress-verdict verdict-" + ingress.outcome}>{ingress.outcome}</span>
      </div>

      <div className="ingress-stats">
        <div><strong>{ingress.scannedFiles}</strong><span>classified</span></div>
        <div><strong>{ingress.withheld.length}</strong><span>withheld</span></div>
        <div><strong>{ingress.earlyStops}</strong><span>stopped early</span></div>
        <div><strong>{formatBytes(ingress.bytesSkipped)}</strong><span>never read</span></div>
      </div>

      {ingress.trifecta && (
        <Surface id={9} active={activeContribution} onHover={onHoverSurface}>
          <Trifecta trifecta={ingress.trifecta} />
        </Surface>
      )}

      <div className="policy-facts">
        <span>clearance: {ingress.clearance}{ingress.effectiveClearance !== ingress.clearance ? " → " + ingress.effectiveClearance : ""}</span>
        <span>mode: {ingress.enforcement}</span>
        <span>adjudicator: {ingress.adjudicator}</span>
        {ingress.adjudicator !== "off" && <span>{judged.length} judged · {judged.filter((record) => record.raised).length} raised</span>}
        {ingress.adjudicationErrors > 0 && <span className="fact-warn">{ingress.adjudicationErrors} unavailable</span>}
      </div>

      {promptFindings.length > 0 && (
        <div className="ingress-findings">
          {promptFindings.map((finding) => (
            <p className="policy-rule" key={finding.id}><strong>{finding.id}</strong> — {finding.text}</p>
          ))}
        </div>
      )}

      {ingress.withheld.length > 0 ? (
        <ul className="withheld-list">
          {ingress.withheld.map((file) => (
            <li key={file.path}>
              <div className="withheld-head">
                <code>{file.path}</code>
                <span className={"level level-" + file.level}>{file.level}</span>
                <span className={"source source-" + file.source}>{file.source === "agent" ? "adjudicator" : "rules"}</span>
              </div>
              <p className="withheld-reason">{file.ruleIds.join(", ")} · {file.reason}</p>
              <div className="read-meter" role="img" aria-label={"Read " + file.bytesInspected + " of " + file.size + " bytes"}>
                <span style={{ width: Math.max(1, Math.min(100, file.size ? (file.bytesInspected / file.size) * 100 : 0)) + "%" }} />
              </div>
              <p className="withheld-meter-label">read {formatBytes(file.bytesInspected)} of {formatBytes(file.size)} before withholding</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="workspace-safe">✓ Nothing above clearance reached the Runtime.</p>
      )}

      {ingress.observed.length > 0 && (
        <details className="ingress-observed">
          <summary>{ingress.observed.length} classified file(s)</summary>
          <ul>
            {ingress.observed.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>
                <span className={"level level-" + file.level}>{file.level}</span>
                <small>{STOP_REASON_LABEL[file.stopReason]}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Wraps one Airlock surface so the "What we built" toggle can number it and
 * link it to the contribution index. Outside reveal mode this renders nothing
 * but a plain wrapper, so the product UI is unchanged when the toggle is off.
 */
function Surface({
  id,
  active,
  onHover,
  children,
}: {
  id: number;
  active: number | null;
  onHover: (id: number | null) => void;
  children: React.ReactNode;
}) {
  const entry = contributions.find((item) => item.id === id);
  return (
    <div
      className={"airlock-surface" + (active === id ? " surface-active" : "")}
      id={"airlock-surface-" + id}
      data-contrib={id}
      data-contrib-label={entry?.title ?? ""}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
    >
      {children}
    </div>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [evidence, setEvidence] = useState<RunEvidence | null>(null);
  const [reveal, setReveal] = useState(false);
  const [activeContribution, setActiveContribution] = useState<number | null>(null);
  // Which numbered surfaces the Playground is currently rendering. The index
  // marks the rest as "not on screen" instead of pointing at nothing.
  const visibleSurfaces = useMemo(() => {
    const visible = new Set<number>();
    if (!evidence) return visible;
    for (const id of [1, 2, 5, 6]) visible.add(id);
    if (evidence.ingress) visible.add(8);
    if (evidence.ingress?.trifecta) visible.add(9);
    if (evidence.run.status === "awaiting_review") { visible.add(3); visible.add(7); }
    if (evidence.policyDecision?.rules.length) visible.add(4);
    return visible;
  }, [evidence]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setEvidence(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
        if (latest && !["queued", "running"].includes(latest.status)) void api.evidence(latest.id).then(({ evidence }) => setEvidence(evidence));
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          const details = await api.evidence(runId);
          if (selectedIdRef.current === agentId) setEvidence(details.evidence);
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const decideRun = async (decision: "approve" | "reject") => {
    if (!activeRun) return;
    const reason = decision === "reject" ? window.prompt("Optional rejection reason") ?? undefined : "Reviewed proposed changes";
    setBusy(true); setError(null);
    try {
      const result = await api.decide(activeRun.id, decision, reason);
      setActiveRun(result.run);
      const details = await api.evidence(result.run.id);
      setEvidence(details.evidence);
      await Promise.all([refreshMessages(result.run.agentId), refreshAgents()]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className={"app-shell" + (reveal ? " reveal-on" : "")}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className={"reveal-toggle" + (reveal ? " on" : "")}
          onClick={() => setReveal((value) => !value)}
          aria-pressed={reveal}
        >
          <span className="reveal-switch" aria-hidden="true">
            <span className="reveal-knob" />
          </span>
          <span className="reveal-copy">
            <strong>What we built</strong>
            <span>
              {reveal
                ? "Airlock surfaces highlighted"
                : contributionSummary.surfaces + " Airlock surfaces"}
            </span>
          </span>
        </button>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy" || selected.status === "review"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy" || selected.status === "review"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                {evidence && (
                  <section className="evidence-panel" aria-label="Run evidence">
                    <Surface id={1} active={activeContribution} onHover={setActiveContribution}>
                      <div className="evidence-heading">
                        <div><span className="eyebrow">Airlock evidence</span><h3>{evidence.run.status === "awaiting_review" ? "Changes quarantined for review" : "Run outcome: " + evidence.run.status}</h3></div>
                        <span className={"risk risk-" + (evidence.policyDecision?.risk ?? "low")}>{evidence.policyDecision?.risk ?? "no-change"} risk</span>
                      </div>
                    </Surface>
                    <Surface id={2} active={activeContribution} onHover={setActiveContribution}>
                      <div className="policy-facts">
                        <span>Container Runtime</span><span>Staging-only workspace</span><span>Private Agent session</span><span>{evidence.policy?.networkMode ?? "policy unavailable"}</span>
                      </div>
                    </Surface>
                    {evidence.ingress && (
                      <Surface id={8} active={activeContribution} onHover={setActiveContribution}>
                        <IngressGate ingress={evidence.ingress} promptScreen={evidence.promptScreen} activeContribution={activeContribution} onHoverSurface={setActiveContribution} />
                      </Surface>
                    )}
                    {evidence.run.status === "awaiting_review" && (
                      <Surface id={3} active={activeContribution} onHover={setActiveContribution}>
                        <p className="workspace-safe">✓ Live workspace unchanged: {evidence.liveWorkspaceUnchanged ? "confirmed" : "conflict detected"}</p>
                      </Surface>
                    )}
                    {evidence.policyDecision?.rules.length ? (
                      <Surface id={4} active={activeContribution} onHover={setActiveContribution}>
                        {evidence.policyDecision.rules.map((rule) => <p className="policy-rule" key={rule.id}><strong>{rule.id}</strong> — {rule.message}</p>)}
                      </Surface>
                    ) : null}
                    <Surface id={5} active={activeContribution} onHover={setActiveContribution}>
                      <div className="change-list">
                        {evidence.changes.map((change) => <details key={change.path}><summary><span className={"change-kind kind-" + change.kind}>{change.kind}</span><code>{change.path}</code><small>{change.size} bytes</small></summary>{change.patch && <pre>{change.patch}</pre>}</details>)}
                        {!evidence.changes.length && <p>No workspace changes were proposed.</p>}
                      </div>
                    </Surface>
                    <Surface id={6} active={activeContribution} onHover={setActiveContribution}>
                      <ol className="audit-timeline">{evidence.timeline.map((event) => <li key={event.id}><time>{formatTime(event.timestamp)}</time><div><strong>{event.type}</strong><span>{event.summary}</span></div></li>)}</ol>
                    </Surface>
                    {evidence.run.status === "awaiting_review" && (
                      <Surface id={7} active={activeContribution} onHover={setActiveContribution}>
                        <div className="decision-actions"><button className="button button-danger" disabled={busy} onClick={() => void decideRun("reject")}>Reject changes</button><button className="button button-primary" disabled={busy || !evidence.liveWorkspaceUnchanged} onClick={() => void decideRun("approve")}>Approve and promote</button></div>
                      </Surface>
                    )}
                  </section>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" || selected.status === "review" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" || selected.status === "review" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {reveal && (
        <aside className="contribution-index" aria-label="Airlock contribution index">
          <div className="contribution-head">
            <span className="eyebrow">Airlock</span>
            <h2>What we built</h2>
            <p>
              Everything highlighted below was added on top of the Volc Agent Launchpad starter
              kit. Everything greyed out shipped with it.
            </p>
            <div className="contribution-stats">
              <div>
                <strong>{contributionSummary.newModules}</strong>
                <span>new modules</span>
              </div>
              <div>
                <strong>{contributionSummary.linesAdded.toLocaleString()}</strong>
                <span>lines added</span>
              </div>
              <div>
                <strong>{contributionSummary.surfaces}</strong>
                <span>UI surfaces</span>
              </div>
            </div>
          </div>

          <ol className="contribution-list">
            {contributions.map((item) => {
              const onScreen = visibleSurfaces.has(item.id);
              return (
                <li
                  key={item.id}
                  className={
                    (activeContribution === item.id ? "active " : "") +
                    (onScreen ? "" : "offscreen")
                  }
                  onMouseEnter={() => setActiveContribution(item.id)}
                  onMouseLeave={() => setActiveContribution(null)}
                >
                  <button
                    onClick={() =>
                      document
                        .getElementById("airlock-surface-" + item.id)
                        ?.scrollIntoView({ behavior: "smooth", block: "center" })
                    }
                  >
                    <span className="contribution-badge">{item.id}</span>
                    <span className="contribution-copy">
                      <strong>{item.title}</strong>
                      <span className="contribution-blurb">{item.blurb}</span>
                      <span className="contribution-file">
                        <code>{item.file}</code>
                        <em>
                          {item.isNewFile ? item.lines + " lines · new file" : "+" + item.lines + " lines"}
                        </em>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <p className="contribution-foot">
            Baseline compared against starter-kit commit <code>{contributionSummary.baselineCommit}</code>.
            Surfaces marked <em>not on screen</em> appear once a Run finishes.
          </p>
        </aside>
      )}

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
