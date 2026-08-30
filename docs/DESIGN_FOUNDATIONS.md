# Design foundations

Airlock's controls are not invented from scratch. Each one is a restatement of
an existing result from the security literature, applied to an autonomous coding
agent. This document records which result, what Airlock takes from it, and —
more usefully — **where Airlock is weaker than the source**, so a reviewer can
tell a grounded design decision from a hopeful one.

Read this before proposing a new control. If a proposal has no line in the
literature, that is not disqualifying, but it needs a stated threat model and an
argument for why the existing models do not already cover it.

---

## 1. The clearance lattice

> Dorothy E. Denning, **A Lattice Model of Secure Information Flow**,
> *Communications of the ACM* 19(5), 1976, pp. 236–243.
> [DOI 10.1145/360051.360056](https://dl.acm.org/doi/10.1145/360051.360056)

Denning shows that the security classes of a system, ordered by permitted flow,
form a lattice, and that "can information at class A reach class B" reduces to a
partial-order comparison. Enforcement becomes a comparison rather than a
case-by-case judgement.

**What Airlock takes.** The clearance levels
`public < internal < confidential < restricted` are a total order — the simplest
possible lattice. `screenWorkspace` compares each classified file against the
Run's clearance and withholds anything strictly above it. This is the read half
of Bell–LaPadula's *no read up*: the subject (the Run) may not read objects
above its level.

**Where Airlock is weaker.** Denning's model governs *flows*, tracking
propagation through computation. Airlock classifies files at rest and enforces
once, at staging time. Once content is inside the container it is unlabelled:
if the agent reads an `internal` file and writes its contents into a `public`
one, nothing downgrades the label. The write-side `TC` rules and human review
are what stand in for flow tracking, and they are a much blunter instrument.

A total order is also a real simplification. Denning's lattice supports
incomparable classes — `finance` and `legal` need not be ordered — which is how
compartmentalisation is normally expressed. Airlock cannot express that. Adding
compartments would mean moving from a chain to a proper lattice, which
`rank()`-based comparison in `sensitivity.ts` would need to be rewritten for.

---

## 2. Declassification must be explicit and attributable

> Andrew C. Myers and Barbara Liskov, **A Decentralized Model for Information
> Flow Control**, *16th ACM Symposium on Operating Systems Principles (SOSP)*,
> 1997.
> [Paper](https://www.cs.cornell.edu/andru/papers/iflow-sosp97/paper.html) ·
> [MIT LCS TR-783](https://publications.csail.mit.edu/lcs/pubs/pdf/MIT-LCS-TR-783.pdf)

The decentralized label model (DLM), developed at MIT LCS, addresses a problem
that pure lattice models leave open: real systems must sometimes release data
downward, and a model with no legitimate downgrade path gets bypassed in
practice. DLM makes declassification a first-class, *authorised* operation — a
principal may weaken only labels it owns, and the act is attributable.

**What Airlock takes.** Raising a Run's clearance is a declassification. The
operator controls in the UI let a human do exactly that, because sometimes a Run
genuinely needs to read a credential file. DLM's lesson is that this must never
be silent, so `updateIngressSettings` records every change with its before and
after value, and computes whether the change *reduces* protection:

```
clearance:   restricted < confidential < internal < public   (raising clearance weakens)
enforcement: off < audit < enforce
```

Weakening entries are flagged in the settings log the evidence panel reads. The
control can be relaxed; it cannot be relaxed invisibly.

**Where Airlock is weaker.** DLM's authority is decentralized and per-principal:
each owner controls its own labels, and no single actor can declassify
everything. Airlock is single-operator — one person can lower every control at
once. There is no notion of principals owning labels, no delegation, and no
separation of duty between the person who sets clearance and the person who
approves promotion. For a single-user proof of concept that is acceptable; for
multi-tenant use it is the first thing that would have to change.

---

## 3. The threat: indirect prompt injection

> Kai Greshake, Sahar Abdelnabi, Shailesh Mishra, Christoph Endres, Thorsten
> Holz, Mario Fritz, **Not What You've Signed Up For: Compromising Real-World
> LLM-Integrated Applications with Indirect Prompt Injection**, *16th ACM
> Workshop on Artificial Intelligence and Security (AISec)*, 2023.
> [arXiv:2302.12173](https://arxiv.org/abs/2302.12173) ·
> [ACM DL](https://dl.acm.org/doi/abs/10.1145/3605764.3623985)

The attack Airlock exists to survive. The adversarial instruction is not typed
by the user; it is planted in content the model retrieves as part of an ordinary
task. The paper demonstrates instructions embedded in retrieved web content
driving an agent to exfiltrate data to an attacker-controlled endpoint.

**What Airlock takes.** The demo fixture in this repo is this attack, not a
paraphrase of it: an HTML comment in a vendored SDK page instructing the agent
to read `.env` and POST it to an external URL. `IN050` and `IN052` detect the
provenance and the phrasing.

**Where Airlock is weaker — and why that is the point.** Detection is *not* the
control. `IN052` is a regex over known phrasings and loses to paraphrase; treat
it as telemetry, not defence. Its only load-bearing role is to establish that
untrusted content is in scope, which feeds the capability check below. If
`IN052` misses an injection entirely, the file still carries `IN050` from its
vendored path, and the withholding still happens because it was never keyed on
recognising the attack.

---

## 4. Defence by construction, not by detection

> Edoardo Debenedetti et al., **Defeating Prompt Injections by Design** (CaMeL),
> 2025. [arXiv:2503.18813](https://arxiv.org/abs/2503.18813)

CaMeL argues that prompt injection should be defeated structurally rather than
by filtering. It extracts control and data flow from the *trusted* query, so
untrusted data can never influence program flow; attaches capability metadata to
every value; and runs a quarantined LLM with no tool access over untrusted data
while a privileged LLM plans from the trusted query.

**What Airlock takes.** The central commitment: the system's guarantee must not
depend on the model behaving. Airlock's version is coarse — capabilities are
assessed per Run rather than per value, and the "quarantine" is the staging
workspace plus withholding rather than a second model. But the property is the
same shape: an injected instruction to read a withheld file arrives at a
container where that file is a tombstone, so whether the model complies is
irrelevant.

**Where Airlock is much weaker.** CaMeL tracks provenance through execution with
a custom interpreter and enforces policy at each tool call. Airlock explicitly
does not — `AGENTS.md` forbids claiming per-tool interception, because Codex
runs autonomously in its Runtime and a read of a bind mount is an ordinary
syscall. Airlock's enforcement is entirely front-loaded: everything is decided
before the mount exists. Consequences:

- Data the agent legitimately reads can be freely mixed and re-emitted inside
  the Run; nothing tracks it.
- A single classification mistake at staging time is unrecoverable for that Run.
- CaMeL reports provable properties on AgentDojo; Airlock offers no such
  guarantee and should not be described as if it did.

---

## 5. Capability removal: the lethal trifecta

> Simon Willison, **The lethal trifecta for AI agents**, 2025.
> https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/

Not peer-reviewed, and cited as an industry framing rather than a result: an
agent is dangerous when it holds private data, exposure to untrusted content,
and the ability to communicate externally *at the same time*. Any two are
survivable.

**What Airlock takes.** `trifecta-policy.ts` assesses the three per Run and,
when the set completes, removes a leg rather than trying to detect the attack.
Which leg depends on the network boundary: behind the Ark-only gateway, comms is
already constrained and the Run keeps its clearance; on `current-bridge`,
`IN061` drops clearance to `public`.

The underlying idea is older than the framing — it is the same reasoning as
capability confinement, where a component that cannot name a resource cannot
reach it. The trifecta is a useful shorthand for which capability is cheapest to
remove.

**Where Airlock is weaker.** The three legs are detected heuristically. "Private
data" depends on classification being right; "untrusted content" depends on
provenance rules; "external comms" is read off the configured network mode and
would be wrong if the container escaped its network. Each leg is a judgement,
and the check is only as good as the weakest of the three.

---

## How to use this when planning

1. **State the threat model first.** Which of the five sections above does the
   proposed control belong to? If none, say what the new class of threat is.
2. **Say what it is a restatement of.** Reuse the vocabulary — lattice,
   declassification, capability, provenance — rather than coining new terms for
   established ideas.
3. **Write the weakness section before the strength section.** Every entry above
   has one. A proposal that cannot articulate how it fails is not ready.
4. **Prefer removing a capability over detecting an attack.** Sections 3 and 4
   are the argument for why: detection loses to paraphrase, construction does
   not.
5. **Never claim a guarantee the architecture cannot deliver.** Airlock is
   front-loaded enforcement with no flow tracking. Claims must stop there.
