/**
 * Avatars are robot faces, not object icons — and they are a *family*: every
 * one is a rounded head with eyes, and exactly one thing varies. That keeps ten
 * bots from reading as ten unrelated illustrations, and it means identity
 * survives without colour, which is what makes the set colourblind-safe.
 */

export const AGENT_COLORS = [
  "#6B8AFF",
  "#9B7BFF",
  "#CE7CD4",
  "#4FB98A",
  "#5B8FB0",
  "#D4739B",
  "#9BC45F",
  "#3FA894",
  "#8E9BC9",
  "#A89484",
] as const;

/** Outside the ten agent hues and outside the three state colours, so the
 *  manager can't be mistaken for either. */
export const MANAGER_COLOR = "#E0D6C3";

/** Hues that mean something else and must never mean "which agent". */
const RESERVED_HUES = [186, 36, 4]; // working (cyan), needs-you (amber), failed (red)
const RESERVED_BAND = 14;

export type HeadShape = "circle" | "flat" | "wide" | "tall" | "hex";
export type Topper = "none" | "antenna" | "twin" | "crown" | "notch";
export type EyeType = "round" | "slit" | "square" | "single";
export type Extra = "none" | "tabs" | "dome" | "phones" | "stand";

export type Face = {
  head: HeadShape;
  topper: Topper;
  eyes: EyeType;
  extra: Extra;
};

const HEADS: HeadShape[] = ["circle", "flat", "wide", "tall", "hex"];
const TOPPERS: Topper[] = ["none", "antenna", "twin", "crown", "notch"];
const EYES: EyeType[] = ["round", "slit", "square", "single"];

/**
 * The canonical ten. Each is the base face with one thing changed, in the order
 * bots get created — so the first bot is always the blue one with the antenna.
 */
const CANONICAL: Face[] = [
  { head: "circle", topper: "antenna", eyes: "round", extra: "none" },
  { head: "circle", topper: "none", eyes: "round", extra: "tabs" },
  { head: "flat", topper: "none", eyes: "slit", extra: "none" },
  { head: "circle", topper: "none", eyes: "round", extra: "dome" },
  { head: "circle", topper: "crown", eyes: "square", extra: "none" },
  { head: "circle", topper: "twin", eyes: "round", extra: "none" },
  { head: "circle", topper: "none", eyes: "single", extra: "none" },
  { head: "circle", topper: "notch", eyes: "round", extra: "none" },
  { head: "circle", topper: "none", eyes: "round", extra: "phones" },
  { head: "circle", topper: "none", eyes: "round", extra: "stand" },
];

/* ------------------------------------------------------------------ colour */

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}

/** Saturation/lightness of the hand-picked ten, so generated hues match them. */
const BASE_SL = (() => {
  const parts = AGENT_COLORS.map(hexToHsl);
  return {
    s: parts.reduce((a, p) => a + p.s, 0) / parts.length,
    l: parts.reduce((a, p) => a + p.l, 0) / parts.length,
  };
})();

const LAST_HUE = hexToHsl(AGENT_COLORS[AGENT_COLORS.length - 1]!).h;

function isReserved(hue: number): boolean {
  return RESERVED_HUES.some((r) => {
    const delta = Math.abs(((hue - r + 540) % 360) - 180);
    return 180 - delta < RESERVED_BAND;
  });
}

/**
 * Past the tenth bot, hues rotate by the golden angle rather than picking at
 * random — the packing trick sunflowers use. Every new colour lands maximally
 * far from every existing one, so bot 11 belongs and bot 40 is still telling
 * itself apart. Random would collide almost immediately.
 */
export function colorForIndex(index: number): string {
  if (index < 0) return MANAGER_COLOR;
  const preset = AGENT_COLORS[index];
  if (preset) return preset;

  let hue = LAST_HUE;
  for (let step = 0; step < index - AGENT_COLORS.length + 1; step++) {
    hue = (hue + 137.5) % 360;
    let guard = 0;
    while (isReserved(hue) && guard++ < 12) hue = (hue + 137.5) % 360;
  }
  return hslToHex(hue, BASE_SL.s, BASE_SL.l);
}

/* -------------------------------------------------------------------- face */

/**
 * The composable vocabulary: 5 heads x 5 toppers x 4 eyes = 100 combinations.
 * Walked with a stride coprime to 100, so consecutive bots differ in several
 * dimensions at once instead of marching through "circle" twenty times.
 */
const STRIDE = 37;

function decode(slot: number): Face {
  const eyes = EYES[slot % EYES.length]!;
  const topper = TOPPERS[Math.floor(slot / EYES.length) % TOPPERS.length]!;
  const head = HEADS[Math.floor(slot / (EYES.length * TOPPERS.length)) % HEADS.length]!;
  return { head, topper, eyes, extra: "none" };
}

function faceKey(face: Face): string {
  return `${face.head}|${face.topper}|${face.eyes}|${face.extra}`;
}

/**
 * Grid slots not already spoken for by one of the canonical ten, in stride
 * order. Because this is a permutation with the canonical faces removed, the
 * compositor is a bijection: the least-used combination is always an unused
 * one, and no two bots can collide until all 104 faces are spent.
 */
const COMPOSED: Face[] = (() => {
  const taken = new Set(CANONICAL.map(faceKey));
  const out: Face[] = [];
  const total = HEADS.length * TOPPERS.length * EYES.length;
  for (let n = 0; n < total; n++) {
    const face = decode((n * STRIDE) % total);
    if (taken.has(faceKey(face))) continue;
    out.push(face);
  }
  return out;
})();

/**
 * Beyond the canonical ten the face is composed from the vocabulary. The
 * compositor takes the least-used combination rather than a random one —
 * random collides almost immediately, and a duplicate face is a bot you
 * cannot tell apart at a glance.
 */
export function faceForIndex(index: number): Face {
  if (index < 0) return { head: "circle", topper: "none", eyes: "round", extra: "none" };
  const preset = CANONICAL[index];
  if (preset) return preset;
  const composed = COMPOSED[(index - CANONICAL.length) % COMPOSED.length];
  return composed ?? CANONICAL[0]!;
}
