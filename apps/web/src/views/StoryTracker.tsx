/**
 * Story & ending tracker (M5.3) — port of auto-tracker/tarkov-story-tracker.tsx
 * onto live /api/story data. All prediction/progress logic lives in
 * lib/story.ts (pure, tested); this file is rendering + interaction only.
 *
 * Artifact v2 parity: ending predictor card with probability grid + LOCKED
 * badge, overall progress bar, collapsible chapters with per-chapter progress,
 * next-task highlight, decision-point stages opening a consequence modal,
 * stage hints + reset. Restyled in the app's plain-CSS dark theme.
 */

import { useState, type ReactNode } from "react";
import { useApp } from "../store";
import {
  chapterProgress,
  decisionWarnings,
  endingOutlook,
  optionConsequence,
  overallProgress,
  stageVisibility,
  visibleStages,
} from "../lib/story";
import { mapDisplayName } from "../lib/maps";
import { Empty, ProgressBar } from "../components/common";
import type { StoryChapter, StoryDecision } from "../api/types";

function DecisionModal({
  decision,
  onClose,
}: {
  decision: StoryDecision;
  onClose: () => void;
}): ReactNode {
  const { story, storyDecisions, setDecision } = useApp();
  const endings = story?.endings ?? [];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>⚠ Decision point</h3>
        <p>{decision.question}</p>
        {decision.options.map((option) => (
          <button
            key={option.id}
            className={`option-btn${storyDecisions[decision.id] === option.id ? " chosen" : ""}`}
            onClick={() => {
              setDecision(decision.id, option.id);
              onClose();
            }}
          >
            <div className="o-label">{option.label}</div>
            <div className="o-desc">{optionConsequence(option, endings)}</div>
          </button>
        ))}
        <p className="sub" style={{ marginTop: 12 }}>
          This choice affects which endings stay reachable.
        </p>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function ChapterBlock({
  chapter,
  expanded,
  onToggle,
  onDecision,
}: {
  chapter: StoryChapter;
  expanded: boolean;
  onToggle: () => void;
  onDecision: (decisionId: string) => void;
}): ReactNode {
  const { story, storyProgress, storyDecisions, setStageDone } = useApp();
  const prog = chapterProgress(chapter, storyProgress, storyDecisions);
  const stages = visibleStages(chapter, storyDecisions);
  const decisionById = new Map((story?.decisions ?? []).map((d) => [d.id, d]));

  return (
    <div className="chapter">
      <button className={`ch-head${prog.complete ? " done" : ""}`} onClick={onToggle}>
        <span className="ch-order">#{chapter.order}</span>
        <span className="ch-name">
          {chapter.name}
          {prog.complete ? " ✓" : ""}
        </span>
        <span className="ch-track">
          <span className="fill" style={{ width: `${prog.pct}%`, display: "block" }} />
        </span>
        <span className="ch-count">
          {prog.done}/{prog.total}
        </span>
        <span className="ch-count">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded ? (
        <div className="stages">
          {stages.map((stage) => {
            const done = storyProgress[stage.id] === true;
            const isDecision = !!stage.decision && storyDecisions[stage.decision!] === undefined;
            const isNext = prog.nextStageId === stage.id;
            const conditional = stageVisibility(stage, storyDecisions) === "conditional";
            const decided = stage.decision ? storyDecisions[stage.decision] : undefined;
            const decidedLabel = decided
              ? decisionById.get(stage.decision!)?.options.find((o) => o.id === decided)?.label
              : undefined;
            const cls = [
              "stage",
              done ? "done" : "",
              isNext && !done ? "next" : "",
              isDecision && !done ? "decision" : "",
              conditional ? "conditional" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={stage.id}
                className={cls}
                title={stage.hint}
                onClick={() => {
                  if (isDecision) onDecision(stage.decision!);
                  else setStageDone(stage.id, !done);
                }}
              >
                <span className="box">{done ? "✓" : isDecision ? "!" : isNext ? "→" : ""}</span>
                <span style={{ flex: 1 }}>
                  <span className="s-name">
                    {stage.name}
                    {stage.optional ? " (optional)" : ""}
                  </span>
                  {stage.hint ? <span className="s-hint"> — {stage.hint}</span> : null}
                  {stage.maps && stage.maps.length > 0 ? (
                    <span className="s-maps"> [{stage.maps.map(mapDisplayName).join(", ")}]</span>
                  ) : null}
                </span>
                {decidedLabel ? <span className="s-hint">{decidedLabel}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function StoryTracker(): ReactNode {
  const { story, storyProgress, storyDecisions, resetStory } = useApp();
  const [expanded, setExpanded] = useState<string | "all" | null>(null);
  const [modalDecision, setModalDecision] = useState<string | null>(null);

  if (!story || story.chapters.length === 0) {
    return <Empty>Story dataset unavailable — is the service running?</Empty>;
  }

  const chapters = [...story.chapters].sort((a, b) => a.order - b.order);
  const outlook = endingOutlook(story.endings, story.decisions, storyDecisions);
  const total = overallProgress(chapters, storyProgress, storyDecisions);
  const warnings = decisionWarnings(
    chapters,
    story.decisions,
    story.endings,
    storyProgress,
    storyDecisions,
  ).filter((w) => w.imminent);
  const predicted = story.endings.find((e) => e.id === outlook.predicted);
  const modal = modalDecision
    ? (story.decisions.find((d) => d.id === modalDecision) ?? null)
    : null;

  return (
    <div>
      <div className="card ending-card" style={{ borderColor: outlook.lockedIn ? "var(--good)" : "var(--accent-dim)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 19 }}>
            {outlook.lockedIn ? "🔒" : "🎯"} {predicted ? predicted.name : "No ending reachable"}
          </strong>
          {predicted ? <span className="sub" style={{ margin: 0 }}>{predicted.subtitle}</span> : null}
          {outlook.lockedIn ? <span className="badge live">LOCKED</span> : null}
        </div>
        {predicted ? <p className="sub" style={{ margin: "4px 0 0" }}>{predicted.description}</p> : null}
        <div className="ending-grid">
          {story.endings.map((ending) => {
            const prob = outlook.probabilities[ending.id] ?? 0;
            const out = prob === 0;
            const lockedBy = outlook.locked.find((l) => l.ending === ending.id);
            return (
              <div
                key={ending.id}
                className={`ending-cell${out ? " out" : ""}${outlook.lockedIn && !out ? " locked-in" : ""}`}
                title={lockedBy ? `Locked out by ${lockedBy.byDecision} → ${lockedBy.option}` : ending.description}
              >
                <div className="e-name">{ending.name}</div>
                <div className="e-sub">{ending.subtitle}</div>
                <div className="e-prob">{prob}%</div>
              </div>
            );
          })}
        </div>
        {Object.keys(storyDecisions).length > 0 ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(storyDecisions).map(([decisionId, optionId]) => {
              const decision = story.decisions.find((d) => d.id === decisionId);
              const option = decision?.options.find((o) => o.id === optionId);
              return decision && option ? (
                <span key={decisionId} className="badge">
                  {option.label}
                </span>
              ) : null;
            })}
          </div>
        ) : null}
      </div>

      {warnings.map((warning) => (
        <div key={warning.decisionId} className="decision-warning">
          <div className="q">⚠ Decision ahead: {warning.question}</div>
          {warning.options.map((option) => (
            <div key={option.id} className="opt">
              <strong>{option.label}</strong>{" "}
              <span className="consequence">{option.consequence}</span>
            </div>
          ))}
        </div>
      ))}

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ flex: 1 }}>
          <ProgressBar label="Story progress" done={total.done} total={total.total} />
        </div>
        <button onClick={() => setExpanded(expanded === "all" ? null : "all")}>
          {expanded === "all" ? "Collapse all" : "Expand all"}
        </button>
        <button
          className="danger"
          onClick={() => {
            if (window.confirm("Reset all story progress and decisions?")) resetStory();
          }}
        >
          Reset
        </button>
      </div>

      {chapters.map((chapter) => (
        <ChapterBlock
          key={chapter.id}
          chapter={chapter}
          expanded={expanded === "all" || expanded === chapter.id}
          onToggle={() => setExpanded(expanded === chapter.id ? null : chapter.id)}
          onDecision={(id) => setModalDecision(id)}
        />
      ))}

      {story.attribution ? <p className="attribution">{story.attribution}</p> : null}

      {modal ? <DecisionModal decision={modal} onClose={() => setModalDecision(null)} /> : null}
    </div>
  );
}
