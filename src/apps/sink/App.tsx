import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

const IMPLEMENTATION = { name: "5pm Sink", version: "1.0.0" };

interface SinkMatch {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

interface SinkResult {
  matches: SinkMatch[];
  namespace: string;
}

function getResultText(result: CallToolResult): string | null {
  const content = result.content;
  if (!Array.isArray(content)) return null;
  const item = content.find((c) => "text" in c);
  if (!item || !("text" in item)) return null;
  return item.text as string;
}

function parseResult(result: CallToolResult): SinkResult | null {
  try {
    const text = getResultText(result);
    if (!text) return null;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!Array.isArray(parsed.matches)) return null;
    return {
      matches: parsed.matches as SinkMatch[],
      namespace: (parsed.namespace as string) ?? "",
    };
  } catch {
    return null;
  }
}

function getErrorMessage(result: CallToolResult): string | null {
  if (!(result as Record<string, unknown>).isError) return null;
  return getResultText(result);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("value" in obj && Object.keys(obj).length === 1) return formatValue(obj.value);
    return JSON.stringify(value);
  }
  return String(value);
}

function SinkApp() {
  const [queryText, setQueryText] = useState<string | null>(null);
  const [sinkResult, setSinkResult] = useState<SinkResult | null>(null);
  const [rawResult, setRawResult] = useState<CallToolResult | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);

  const { app, error } = useApp({
    appInfo: IMPLEMENTATION,
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolinput = async (input) => {
        const args = input.arguments as Record<string, unknown> | undefined;
        setQueryText((args?.query as string) ?? null);
        setToolError(null);
        setSinkResult(null);
        setRawResult(null);
      };
      app.ontoolresult = async (result) => {
        setRawResult(result);
        const errMsg = getErrorMessage(result);
        if (errMsg) {
          setToolError(errMsg);
          setSinkResult(null);
        } else {
          setToolError(null);
          setSinkResult(parseResult(result));
        }
      };
      app.onerror = (err) => console.error("[5pm Sink]", err);
    },
  });

  if (error) {
    return (
      <div style={s.container}>
        <Header />
        <p style={s.error}>{error.message}</p>
      </div>
    );
  }

  if (!app) {
    return (
      <div style={s.container}>
        <Header />
        <p style={s.muted}>Connecting...</p>
      </div>
    );
  }

  return (
    <div style={s.container}>
      <Header />

      <section style={s.section}>
        <h2 style={s.h2}>Search Query</h2>
        {queryText ? (
          <pre style={s.code}>{queryText}</pre>
        ) : (
          <p style={s.muted}>Waiting for query...</p>
        )}
      </section>

      <section style={s.section}>
        <h2 style={s.h2}>Results</h2>
        {toolError ? (
          <p style={s.error}>{toolError}</p>
        ) : sinkResult ? (
          <>
            <p style={s.meta}>
              {sinkResult.matches.length} match{sinkResult.matches.length !== 1 ? "es" : ""}
              {sinkResult.namespace ? ` in namespace "${sinkResult.namespace}"` : ""}
            </p>
            {sinkResult.matches.map((match, i) => (
              <div key={match.id ?? i} style={s.card}>
                <div style={s.cardHeader}>
                  <span style={s.matchId}>{match.id}</span>
                  {match.score != null && (
                    <span style={s.score}>{(match.score * 100).toFixed(1)}%</span>
                  )}
                </div>
                {match.metadata && Object.keys(match.metadata).length > 0 && (
                  <table style={s.metaTable}>
                    <tbody>
                      {Object.entries(match.metadata).map(([key, val]) => (
                        <tr key={key}>
                          <td style={s.metaKey}>{key}</td>
                          <td style={s.metaVal}>{formatValue(val)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </>
        ) : rawResult ? (
          <pre style={s.code}>{JSON.stringify(rawResult, null, 2)}</pre>
        ) : (
          <p style={s.muted}>Waiting for results...</p>
        )}
      </section>
    </div>
  );
}

function Header() {
  return (
    <div style={s.header}>
      <span style={s.logo}>5pm</span>
      <span style={s.logoSub}>sink</span>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: "system-ui, -apple-system, sans-serif",
    padding: "1.25rem",
    background: "#111111",
    color: "#fefefe",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.5rem",
    marginBottom: "1.5rem",
  },
  logo: { fontSize: "1.5rem", fontWeight: 700, color: "#d89998" },
  logoSub: { fontSize: "1rem", color: "#888" },
  section: { marginBottom: "1.5rem" },
  h2: {
    fontSize: "0.85rem",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    color: "#888",
    margin: "0 0 0.5rem 0",
  },
  code: {
    background: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: "6px",
    padding: "0.75rem",
    fontSize: "0.85rem",
    overflow: "auto",
    whiteSpace: "pre-wrap" as const,
    color: "#ccc",
    margin: 0,
  },
  muted: { color: "#555", fontStyle: "italic" },
  error: { color: "#e55" },
  meta: { color: "#888", fontSize: "0.8rem", margin: "0 0 0.75rem 0" },
  card: {
    background: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: "8px",
    padding: "0.75rem",
    marginBottom: "0.5rem",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "0.5rem",
  },
  matchId: {
    fontSize: "0.8rem",
    color: "#d89998",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
    maxWidth: "80%",
  },
  score: {
    fontSize: "0.75rem",
    color: "#888",
    fontWeight: 600,
    flexShrink: 0,
  },
  metaTable: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "0.8rem",
  },
  metaKey: {
    padding: "0.2rem 0.5rem 0.2rem 0",
    color: "#888",
    verticalAlign: "top",
    whiteSpace: "nowrap" as const,
    width: "1%",
  },
  metaVal: {
    padding: "0.2rem 0",
    color: "#ccc",
    wordBreak: "break-word" as const,
  },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SinkApp />
  </StrictMode>
);
