// Turns the flat "groceries <1' · 132" per-layer lines into a set-relative
// "more dining & groceries · less green space" line. T-019 validated the
// straight-line `nearby` count as a proxy for the graph-true reachable count
// and found it wanders 0.50-1.52x — useless for magnitude, though its
// Spearman rank correlation against graph-true (0.983) means the ORDER still
// holds. So printing the count invites a magnitude reading it cannot
// support — a z-score on log(1+count) only ever claims "more/less than the
// others here", never "this many".

// Layers whose log(1+count) barely varies across the ten results are
// effectively uniform, and labelling any of them would be noise, not signal.
// 0.15 in log space is roughly a 16% spread — below that, don't bother.
const STDEV_SKIP_THRESHOLD = 0.15;

// z-score cutoff for a layer to earn a "more X" / "less X" label. With ten
// samples, 0.8 flags roughly the top and bottom two or three — a label that
// fired on all ten would say nothing.
const Z_LABEL_THRESHOLD = 0.8;

export type Character<L extends string> = { more: L[]; less: L[] };

type CellInput<L extends string> = {
  layers: Partial<Record<L, number>>;
  nearby?: Partial<Record<L, number>>;
};

// Pure: one Character per cell, same order as `cells`. `layers` should be
// the set the caller actually weighted (unweighted layers are absent from
// the response and have nothing to compare).
export function areaCharacter<L extends string>(
  cells: CellInput<L>[],
  layers: L[]
): Character<L>[] {
  // Per layer, a z-score per cell (undefined where the cell isn't usable for
  // that layer, or the whole layer got skipped for having too little spread).
  const zByLayer = new Map<L, (number | undefined)[]>();

  for (const layer of layers) {
    const usable: { index: number; v: number }[] = [];
    cells.forEach((c, i) => {
      // Unreachable (layers[L] absent) or not backfilled (nearby[L] absent)
      // cells can't be scored on this layer and don't feed its statistics.
      if (c.layers[layer] != null && c.nearby?.[layer] != null) {
        usable.push({ index: i, v: Math.log(1 + (c.nearby[layer] as number)) });
      }
    });
    if (usable.length < 3) continue;

    const mean = usable.reduce((s, u) => s + u.v, 0) / usable.length;
    const variance =
      usable.reduce((s, u) => s + (u.v - mean) ** 2, 0) / usable.length;
    const stdev = Math.sqrt(variance); // population, not sample: describing this fixed ten, not inferring beyond it
    if (stdev < STDEV_SKIP_THRESHOLD) continue;

    const z: (number | undefined)[] = new Array(cells.length).fill(undefined);
    usable.forEach((u) => {
      z[u.index] = (u.v - mean) / stdev;
    });
    zByLayer.set(layer, z);
  }

  return cells.map((_, i) => {
    const scored: { layer: L; z: number }[] = [];
    zByLayer.forEach((zs, layer) => {
      const z = zs[i];
      if (z != null) scored.push({ layer, z });
    });
    const more = scored
      .filter((s) => s.z >= Z_LABEL_THRESHOLD)
      .sort((a, b) => b.z - a.z)
      .slice(0, 2)
      .map((s) => s.layer);
    const less = scored
      .filter((s) => s.z <= -Z_LABEL_THRESHOLD)
      .sort((a, b) => a.z - b.z)
      .slice(0, 1)
      .map((s) => s.layer);
    return { more, less };
  });
}

// ponytail: self-check instead of a test framework this repo doesn't have.
// import.meta.env.DEV is statically replaced by Vite, so the production
// build's dead-code elimination drops this whole block (verified: grep the
// built dist/ bundle for DEMO_MARKER — it isn't there).
if (import.meta.env.DEV) {
  const DEMO_MARKER = "areaCharacter.demo";
  const cells = [
    { layers: { groceries: 30, dining: 30 }, nearby: { groceries: 200, dining: 5 } },
    { layers: { groceries: 30, dining: 30 }, nearby: { groceries: 190, dining: 4 } },
    { layers: { groceries: 30, dining: 30 }, nearby: { groceries: 180, dining: 6 } },
    { layers: { groceries: 30, dining: 30 }, nearby: { groceries: 5, dining: 200 } },
    { layers: { groceries: 30, dining: 30 }, nearby: { groceries: 6, dining: 190 } },
  ];
  const result = areaCharacter(cells, ["groceries", "dining"] as const as ("groceries" | "dining")[]);
  console.assert(result.length === cells.length, `${DEMO_MARKER}: length mismatch`);
  console.assert(
    result[0].more.includes("groceries") && !result[0].more.includes("dining"),
    `${DEMO_MARKER}: cell 0 should read more-groceries`
  );
  console.assert(
    result[3].more.includes("dining") && !result[3].more.includes("groceries"),
    `${DEMO_MARKER}: cell 3 should read more-dining`
  );
  // A layer with near-identical counts everywhere gets no label at all.
  const flat = areaCharacter(
    [
      { layers: { health: 30 }, nearby: { health: 10 } },
      { layers: { health: 30 }, nearby: { health: 10 } },
      { layers: { health: 30 }, nearby: { health: 11 } },
    ],
    ["health"]
  );
  console.assert(
    flat.every((c) => c.more.length === 0 && c.less.length === 0),
    `${DEMO_MARKER}: near-flat layer should stay unlabelled`
  );
}
