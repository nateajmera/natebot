import { memo } from "react";
import { MANAGER_COLOR, colorForIndex, faceForIndex, type Face } from "./identity";

export type AvatarState = "idle" | "working" | "attention" | "failed";

type Props = {
  colorIndex: number;
  faceIndex: number;
  kind: "manager" | "worker";
  size?: number;
  state?: AvatarState;
};

/* The app background, referenced as a token so the palette stays single-source. */
const EYE_DARK = "var(--bg)";

function HeadPath({ shape, color }: { shape: Face["head"]; color: string }) {
  switch (shape) {
    case "flat":
      // Circle with the crown flattened — reads as a different silhouette at 9px.
      return <path d="M4 17a12 12 0 0 1 24 0v3a12 12 0 0 1-24 0z" fill={color} />;
    case "wide":
      return <rect x="2.5" y="7" width="27" height="18" rx="9" fill={color} />;
    case "tall":
      return <rect x="7" y="3" width="18" height="26" rx="9" fill={color} />;
    case "hex":
      return <path d="M16 3.5 27 9.75v12.5L16 28.5 5 22.25V9.75z" fill={color} />;
    case "circle":
    default:
      return <circle cx="16" cy="16" r="12.5" fill={color} />;
  }
}

function Eyes({ type, working }: { type: Face["eyes"]; working: boolean }) {
  const cls = working ? "nb-eyes nb-eyes--working" : "nb-eyes";
  if (type === "single") {
    return (
      <g className={cls}>
        <circle cx="16" cy="16.5" r="5" fill={EYE_DARK} />
      </g>
    );
  }
  if (type === "slit") {
    return (
      <g className={cls}>
        <rect x="9" y="15" width="5.5" height="2.4" rx="1.2" fill={EYE_DARK} />
        <rect x="17.5" y="15" width="5.5" height="2.4" rx="1.2" fill={EYE_DARK} />
      </g>
    );
  }
  if (type === "square") {
    return (
      <g className={cls}>
        <rect x="10" y="13.6" width="4.4" height="4.4" rx="1.2" fill={EYE_DARK} />
        <rect x="17.6" y="13.6" width="4.4" height="4.4" rx="1.2" fill={EYE_DARK} />
      </g>
    );
  }
  return (
    <g className={cls}>
      <circle cx="12.2" cy="16" r="2.35" fill={EYE_DARK} />
      <circle cx="19.8" cy="16" r="2.35" fill={EYE_DARK} />
    </g>
  );
}

function Topper({ type, color }: { type: Face["topper"]; color: string }) {
  switch (type) {
    case "antenna":
      return (
        <g>
          <rect x="15.2" y="0.5" width="1.6" height="4" rx="0.8" fill={color} />
          <circle cx="16" cy="1.2" r="1.9" fill={color} />
        </g>
      );
    case "twin":
      return (
        <g>
          <rect x="9.6" y="1.6" width="1.5" height="4" rx="0.75" fill={color} transform="rotate(-18 10.35 3.6)" />
          <rect x="20.9" y="1.6" width="1.5" height="4" rx="0.75" fill={color} transform="rotate(18 21.65 3.6)" />
          <circle cx="9.4" cy="1.7" r="1.6" fill={color} />
          <circle cx="22.6" cy="1.7" r="1.6" fill={color} />
        </g>
      );
    case "crown":
      return <rect x="8" y="1.2" width="16" height="2.8" rx="1.4" fill={color} />;
    case "notch":
      return <rect x="13" y="1.4" width="6" height="3" rx="1.4" fill={color} />;
    case "none":
    default:
      return null;
  }
}

function Extra({ type, color }: { type: Face["extra"]; color: string }) {
  switch (type) {
    case "tabs":
      return (
        <g>
          <rect x="0.5" y="12.5" width="3.4" height="7" rx="1.7" fill={color} />
          <rect x="28.1" y="12.5" width="3.4" height="7" rx="1.7" fill={color} />
        </g>
      );
    case "phones":
      return (
        <g>
          <circle cx="2.6" cy="16" r="2.6" fill={color} />
          <circle cx="29.4" cy="16" r="2.6" fill={color} />
        </g>
      );
    case "dome":
      return (
        <g>
          <path d="M9.5 6a6.5 6.5 0 0 1 13 0z" fill={color} />
          {/* the one face in the set that smiles */}
          <path d="M12.4 20.6a4.6 4.6 0 0 0 7.2 0" stroke={EYE_DARK} strokeWidth="1.7" strokeLinecap="round" fill="none" />
        </g>
      );
    case "stand":
      return (
        <g>
          <rect x="14.6" y="27" width="2.8" height="3.4" rx="1.2" fill={color} />
          <rect x="9.5" y="29.4" width="13" height="2.2" rx="1.1" fill={color} />
        </g>
      );
    case "none":
    default:
      return null;
  }
}

/**
 * The manager is told apart by shape before colour: a squircle among circles
 * reads instantly at 9px and survives colourblindness. It carries *fewer*
 * shapes than any worker — presence through scale, not ornament.
 */
function ManagerFace({ working }: { working: boolean }) {
  return (
    <>
      <rect x="1.5" y="1.5" width="29" height="29" rx="9.5" fill={MANAGER_COLOR} />
      <g className={working ? "nb-eyes nb-eyes--working" : "nb-eyes"}>
        <circle cx="10.6" cy="16" r="3.35" fill={EYE_DARK} />
        <circle cx="21.4" cy="16" r="3.35" fill={EYE_DARK} />
      </g>
    </>
  );
}

export const Avatar = memo(function Avatar({
  colorIndex,
  faceIndex,
  kind,
  size = 32,
  state = "idle",
}: Props) {
  const isManager = kind === "manager";
  const color = isManager ? MANAGER_COLOR : colorForIndex(colorIndex);
  const face = faceForIndex(faceIndex);
  const working = state === "working";

  return (
    <svg
      className="nb-avatar"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-hidden="true"
      style={{ display: "block", flex: "none" }}
    >
      {isManager ? (
        <ManagerFace working={working} />
      ) : (
        <>
          <Topper type={face.topper} color={color} />
          <Extra type={face.extra} color={color} />
          <HeadPath shape={face.head} color={color} />
          <Eyes type={face.eyes} working={working} />
        </>
      )}
    </svg>
  );
});

export function avatarColor(kind: "manager" | "worker", colorIndex: number): string {
  return kind === "manager" ? MANAGER_COLOR : colorForIndex(colorIndex);
}
