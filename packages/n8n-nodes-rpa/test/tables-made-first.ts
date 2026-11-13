/**
 * The check that every Data Table a workflow reads or writes was made (create if missing) before, on every path that
 * leads there. On a new n8n there is no table yet: a Data Table node on a missing table fails, or with "continue" gives an
 * error item that n8n 2.45 cannot read in an expression (round 13, Z1). Used for the templates and the generated workflow.
 *
 * It walks the connections from every node without an input (the triggers) as n8n's v1 order runs them: a node's
 * children on one output run top first (then left first), each branch to its end before the next. So a table counts
 * as made at a node when a create of it is on every way there, or is the straight chain that an earlier child of the
 * same output starts (Settings → [Create steps table → Create run log table, the rest]).
 */
const DATA_TABLE = 'n8n-nodes-base.dataTable';
const STICKY = 'n8n-nodes-base.stickyNote';

interface Node { name: string; type: string; position: [number, number]; parameters: Record<string, unknown> }
interface Flow { nodes: Node[]; connections: Record<string, { main?: ({ node: string }[] | null)[] } | Record<string, unknown>> }

/** The table a create makes, or none. */
function made(n: Node): string | undefined {
  const p = n.parameters as { resource?: string; operation?: string; tableName?: string; options?: { createIfNotExists?: boolean } };
  return n.type === DATA_TABLE && p.resource === 'table' && p.operation === 'create' && p.options?.createIfNotExists === true ? p.tableName : undefined;
}
/** The table a row operation (get, insert, update, upsert, delete) reads or writes, or none. */
export function used(n: Node): string | undefined {
  const p = n.parameters as { resource?: string; dataTableId?: { value?: string } };
  return n.type === DATA_TABLE && p.resource === 'row' ? String(p.dataTableId?.value ?? '') : undefined;
}

/** Each node that reads or writes a table not made before it on every path, as "<node> uses <table>". Empty: all made first. */
export function tablesNotMadeFirst(w: Flow): string[] {
  const byName = new Map(w.nodes.map((n) => [n.name, n]));
  const outputs = (name: string) => ((w.connections[name] as { main?: ({ node: string }[] | null)[] } | undefined)?.main ?? []).map((out) => [...new Set((out ?? []).map((c) => c.node))]);
  const top = (a: string, b: string) => {
    const [pa, pb] = [byName.get(a)!.position, byName.get(b)!.position];
    return pa[1] - pb[1] || pa[0] - pb[0];
  };
  /** The tables a branch makes first: its first node and the straight chain after it (one output, one node). */
  const chain = (start: string): string[] => {
    const tables: string[] = [];
    const seen = new Set<string>();
    for (let n: string | undefined = start; n !== undefined && !seen.has(n); ) {
      seen.add(n);
      const t = made(byName.get(n)!);
      if (t) tables.push(t);
      const outs = outputs(n);
      n = outs.length === 1 && outs[0].length === 1 ? outs[0][0] : undefined;
    }
    return tables;
  };
  const inputs = new Set(Object.keys(w.connections).flatMap((from) => outputs(from).flat()));
  const roots = w.nodes.filter((n) => n.type !== STICKY && !inputs.has(n.name)).map((n) => n.name);
  // Made before each node, on every way there: the intersection over its inputs, from "everything" down to a fixpoint.
  const before = new Map<string, Set<string> | 'all'>(w.nodes.map((n) => [n.name, 'all']));
  for (const r of roots) before.set(r, new Set());
  for (let changed = true; changed; ) {
    changed = false;
    for (const from of byName.keys()) {
      const mine = before.get(from)!;
      if (mine === 'all') continue;
      const after = new Set(mine);
      const t = made(byName.get(from)!);
      if (t) after.add(t);
      for (const out of outputs(from)) {
        const credit = new Set(after);
        for (const child of [...out].sort(top)) {
          const had = before.get(child)!;
          const next = had === 'all' ? new Set(credit) : new Set([...had].filter((x) => credit.has(x)));
          if (had === 'all' || next.size !== had.size) {
            before.set(child, next);
            changed = true;
          }
          for (const x of chain(child)) credit.add(x);
        }
      }
    }
  }
  return w.nodes.flatMap((n) => {
    const t = used(n);
    const b = before.get(n.name)!;
    return t !== undefined && b !== 'all' && !b.has(t) ? [`${n.name} uses ${t}`] : [];
  });
}
