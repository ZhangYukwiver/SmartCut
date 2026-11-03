import type { EditFit, EditKeyframe, EditMediaSegment, EditTimeRange, EditTransform } from "../../src/services/aiEdit";

export interface Size { width: number; height: number }
export interface LayerRect { left: number; top: number; width: number; height: number; rotation: number; flipX: boolean; flipY: boolean; opacity: number }
export interface MaskSpec {
  mask_type: string; center_x?: number; center_y?: number; size?: number; rotation?: number;
  feather?: number; invert?: boolean; rect_width?: number | null; round_corner?: number | null;
}
export interface LayerCss {
  position: "absolute"; left: number; top: number; width: number; height: number; objectFit: "fill" | "cover" | "contain";
  transform: string; opacity: number; filter?: string; clipPath?: string; [mask: string]: string | number | undefined;
}
type Fade = { in_duration_us: number; out_duration_us: number } | null;

export function keyframeValue(keyframes: EditKeyframe[] | undefined, property: string, offsetUs: number): number | null;
export const IDENTITY_TRANSFORM: EditTransform;
export function effectiveTransform(segment: { transform?: EditTransform | null; keyframes?: EditKeyframe[] }, offsetUs: number): EditTransform;
export function colorFilter(keyframes: EditKeyframe[] | undefined, offsetUs: number): string;
export function fadeGain(segment: { timeline: EditTimeRange; fade?: Fade }, offsetUs: number): number;
export function volumeAt(segment: { timeline: EditTimeRange; fade?: Fade; volume?: number; keyframes?: EditKeyframe[] }, offsetUs: number): number;
export function fitBox(stage: Size, media: Partial<Size> | null | undefined, fit?: EditFit): Size;
export function hasScaleKeyframes(keyframes: EditKeyframe[] | undefined): boolean;
export function layerBox(stage: Size, media: Partial<Size> | null | undefined, fit?: EditFit, keyframes?: EditKeyframe[]): Size;
export function layerRect(stage: Size, box: Size, transform: EditTransform): LayerRect;
export function cssTransform(rect: Pick<LayerRect, "rotation" | "flipX" | "flipY">): string;
export function cropClipPath(crop: EditMediaSegment["crop"]): string | null;
export function maskCss(mask: MaskSpec | null | undefined, element: Size, material: Partial<Size> | null | undefined): Record<string, string> | null;
export function featureName(raw: string | null | undefined): string;
export function filterLook(name: string, strength: number): string;
export function layerStyle(
  stage: Size, segment: Pick<EditMediaSegment, "keyframes" | "transform" | "fit" | "filters" | "crop" | "mask">, material: Partial<Size> | null | undefined, offsetUs: number, box?: Size,
): { rect: LayerRect; css: LayerCss };
export const CLIP_LOOK_SOURCE: string;
