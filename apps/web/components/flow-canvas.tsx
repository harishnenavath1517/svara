"use client";

import {
  Background,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  FLOW_EDGES,
  FLOW_NODES,
  FLOW_LIMITS,
  LATENCY_BUDGET_MS,
  SPEECH_LANGUAGES,
  STT_MODES,
  TTS_SPEAKERS,
  type FlowConfig,
  type FlowNodeId,
  type FlowPatch,
} from "@svara/shared/browser";
import { useMemo } from "react";

/**
 * The turn, as a canvas. One node per Temporal activity, edges typed by
 * docs/DATA_CONTRACTS.md.
 *
 * Two things this deliberately does NOT do, because each would be a way for it to
 * lie about the system underneath it:
 *
 * 1. **The edges do not drag.** The three hops start *concurrently* and hand off
 *    through an in-worker bus — TTS is already subscribed before the LLM has
 *    written a word. An edge the user drew from TTS back to STT is not a pipeline
 *    the runtime can honour, and a canvas that accepted it would be drawing a flow
 *    that does not exist. What is configurable here is what the runtime actually
 *    reads: every knob on every node is a field of `FlowConfig`, and `FlowConfig`
 *    is what the activities take as input.
 * 2. **The live node states are inferred; the numbers are not.** "Active" and
 *    "done" are read off the caller's own WebSocket, which is a coarse view — and
 *    an honest one only because it is labelled as such. The millisecond figures
 *    that land on the nodes after the turn are the hop's own trace rows, fetched
 *    from Postgres. When a hop fails before it emits anything, the inference sees
 *    nothing and the trace row is the only thing that knows.
 */

export type HopState = "idle" | "active" | "done" | "failed";

/** What a hop's own trace row says, once it has landed in Postgres. */
export interface HopTrace {
  latency_ms: number;
  ttfb_ms: number | null;
  model: string;
  error_code: string | null;
}

export interface FlowNodeData extends Record<string, unknown> {
  id: FlowNodeId;
  label: string;
  activity: string | null;
  state: HopState;
  /** The resolved flow — the gateway's, never the browser's optimistic copy. */
  flow: FlowConfig;
  trace: HopTrace | null;
  /** Null while the call is up: a knob may not move a turn that is already running. */
  onChange: ((patch: FlowPatch) => void) | null;
}

type FlowNode = Node<FlowNodeData, "hop">;

/** Node width is 200; the gap has to leave the edge's payload label room to be read. */
const X_STEP = 330;

export function FlowCanvas({
  flow,
  states,
  traces,
  onChange,
}: {
  flow: FlowConfig;
  states: Record<FlowNodeId, HopState>;
  traces: Partial<Record<FlowNodeId, HopTrace>>;
  onChange: ((patch: FlowPatch) => void) | null;
}) {
  const nodes = useMemo<FlowNode[]>(
    () =>
      FLOW_NODES.map((spec, index) => ({
        id: spec.id,
        type: "hop" as const,
        position: { x: index * X_STEP, y: 0 },
        data: {
          id: spec.id,
          label: spec.label,
          activity: spec.activity,
          state: states[spec.id],
          flow,
          trace: traces[spec.id] ?? null,
          onChange,
        },
      })),
    [flow, states, traces, onChange],
  );

  const edges = useMemo<Edge[]>(
    () =>
      FLOW_EDGES.map((edge) => ({
        id: `${edge.from}->${edge.to}`,
        source: edge.from,
        target: edge.to,
        label: edge.payload,
        // The carrier is on the edge because these four arrows are three different
        // transports, and pretending otherwise is how people conclude the hops run
        // in sequence. Only the `turn bus` edges are the ones that overlap.
        labelStyle: { fill: "#8a95a3", fontSize: 10 },
        labelBgStyle: { fill: "#14181d" },
        style: { stroke: edge.carrier === "turn bus" ? "#5eead4" : "#3a424c" },
        animated: states[edge.from] === "active" || states[edge.from] === "done",
      })),
    [states],
  );

  return (
    <div className="canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        // You can move the boxes. You cannot rewire the pipe — see the note above.
        nodesConnectable={false}
        edgesReconnectable={false}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#262c34" gap={18} />
      </ReactFlow>
    </div>
  );
}

function HopNode({ data }: NodeProps<FlowNode>) {
  const { flow, trace, onChange } = data;
  const budget = data.id in LATENCY_BUDGET_MS ? LATENCY_BUDGET_MS[data.id as "stt"] : null;
  const locked = onChange === null;

  return (
    <div className={`hop-node ${data.state}`}>
      {data.id !== "caller" && <Handle type="target" position={Position.Left} />}
      {data.id !== "speaker" && <Handle type="source" position={Position.Right} />}

      <div className="hop-node-head">
        <span className="hop-node-title">{data.label}</span>
        <span className={`hop-dot ${data.state}`} />
      </div>

      {data.activity !== null && (
        <div className="hop-node-activity">
          <code>{data.activity}()</code>
        </div>
      )}

      {data.id === "stt" && (
        <>
          <Knob label="model">saaras:v3</Knob>
          <Select
            label="mode"
            value={flow.stt.mode}
            options={STT_MODES}
            disabled={locked}
            onChange={(mode) => onChange?.({ stt: { mode } })}
          />
          <Select
            label="lang"
            value={flow.stt.lang}
            options={["unknown", ...SPEECH_LANGUAGES]}
            disabled={locked}
            onChange={(lang) => onChange?.({ stt: { lang } })}
          />
        </>
      )}

      {data.id === "llm" && (
        <>
          <Knob label="model">{flow.llm.model}</Knob>
          <Range
            label="temp"
            value={flow.llm.temperature}
            step={0.1}
            range={FLOW_LIMITS.temperature}
            disabled={locked}
            onChange={(temperature) => onChange?.({ llm: { temperature } })}
          />
          <Range
            label="max_tokens"
            value={flow.llm.maxTokens}
            step={128}
            range={FLOW_LIMITS.maxTokens}
            disabled={locked}
            onChange={(maxTokens) => onChange?.({ llm: { maxTokens } })}
          />
          <label className="hop-check nodrag">
            <input
              type="checkbox"
              checked={flow.llm.thinking}
              disabled={locked}
              onChange={(event) => onChange?.({ llm: { thinking: event.target.checked } })}
            />
            <span>thinking</span>
            {flow.llm.thinking && <span className="tag bad">eats the budget</span>}
          </label>
        </>
      )}

      {data.id === "tts" && (
        <>
          <Knob label="model">bulbul:v3</Knob>
          <Select
            label="speaker"
            value={flow.tts.speaker}
            options={TTS_SPEAKERS}
            disabled={locked}
            onChange={(speaker) => onChange?.({ tts: { speaker } })}
          />
          <Range
            label="pace"
            value={flow.tts.pace}
            step={0.1}
            range={FLOW_LIMITS.pace}
            disabled={locked}
            onChange={(pace) => onChange?.({ tts: { pace } })}
          />
        </>
      )}

      {data.id === "caller" && <div className="hop-node-note">mic · PCM16 @16k · VAD + barge-in</div>}
      {data.id === "speaker" && <div className="hop-node-note">scheduled PCM queue @24k</div>}

      {/* The measured half. Everything above is what we asked for; this is what happened. */}
      {trace !== null && (
        <div className="hop-node-metrics">
          {trace.error_code !== null ? (
            <span className="tag bad">{trace.error_code}</span>
          ) : (
            <>
              <span className={overBudget(trace.ttfb_ms, budget) ? "over-budget" : "good"}>
                {trace.ttfb_ms === null ? "—" : `${trace.ttfb_ms} ms`}
              </span>
              <span className="muted"> ttfb</span>
              {budget !== null && <span className="muted"> / {budget}</span>}
            </>
          )}
          <div className="muted hop-node-wall">wall {trace.latency_ms} ms</div>
        </div>
      )}
    </div>
  );
}

/** Registered once, at module scope: React Flow re-mounts every node if this identity changes. */
const NODE_TYPES = { hop: HopNode };

function overBudget(ttfb: number | null, budget: number | null): boolean {
  return ttfb !== null && budget !== null && ttfb > budget;
}

function Knob({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="hop-knob">
      <span className="hop-knob-label">{label}</span>
      <code>{children}</code>
    </div>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="hop-knob">
      <span className="hop-knob-label">{label}</span>
      {/* nodrag: without it, React Flow swallows the pointer and the select never opens. */}
      <select
        className="nodrag"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

function Range({
  label,
  value,
  step,
  range,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  range: { min: number; max: number };
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="hop-knob">
      <span className="hop-knob-label">{label}</span>
      <input
        className="nodrag"
        type="range"
        min={range.min}
        max={range.max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <code className="hop-knob-value">{value}</code>
    </div>
  );
}
