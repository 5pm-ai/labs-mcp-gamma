import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

const IMPLEMENTATION = { name: "5pm Warehouse", version: "1.0.0" };

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

function parseResult(result: CallToolResult): QueryResult | null {
  try {
    const content = result.content;
    if (!Array.isArray(content)) return null;
    const text = content.find((c) => "text" in c);
    if (!text || !("text" in text)) return null;
    return JSON.parse(text.text as string) as QueryResult;
  } catch {
    return null;
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function WarehouseApp() {
  const [sql, setSql] = useState<string | null>(null);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [rawResult, setRawResult] = useState<CallToolResult | null>(null);

  const { app, error } = useApp({
    appInfo: IMPLEMENTATION,
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolinput = async (input) => {
        const args = input.arguments as Record<string, unknown> | undefined;
        setSql((args?.sql as string) ?? null);
      };
      app.ontoolresult = async (result) => {
        setRawResult(result);
        setQueryResult(parseResult(result));
      };
      app.onerror = (err) => console.error("[5pm Warehouse]", err);
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
        <h2 style={s.h2}>Query</h2>
        {sql ? (
          <pre style={s.code}>{sql}</pre>
        ) : (
          <p style={s.muted}>Waiting for query...</p>
        )}
      </section>

      <section style={s.section}>
        <h2 style={s.h2}>Results</h2>
        {queryResult ? (
          <>
            <p style={s.meta}>{queryResult.rowCount} row{queryResult.rowCount !== 1 ? "s" : ""}</p>
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {queryResult.columns.map((col) => (
                      <th key={col} style={s.th}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queryResult.rows.map((row, i) => (
                    <tr key={i}>
                      {queryResult.columns.map((col) => (
                        <td key={col} style={s.td}>{formatCell(row[col])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
      <span style={s.logoSub}>warehouse</span>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: "system-ui, -apple-system, sans-serif",
    padding: "1.25rem",
    background: "#111111",
    color: "#fefefe",
    minHeight: "100vh",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.5rem",
    marginBottom: "1.5rem",
  },
  logo: {
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "#d89998",
  },
  logoSub: {
    fontSize: "1rem",
    color: "#888",
  },
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
  meta: { color: "#888", fontSize: "0.8rem", margin: "0 0 0.5rem 0" },
  tableWrap: { overflow: "auto" },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "0.85rem",
  },
  th: {
    textAlign: "left" as const,
    padding: "0.4rem 0.75rem",
    borderBottom: "1px solid #333",
    color: "#d89998",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
  td: {
    padding: "0.4rem 0.75rem",
    borderBottom: "1px solid #1e1e1e",
    color: "#ccc",
  },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WarehouseApp />
  </StrictMode>
);
