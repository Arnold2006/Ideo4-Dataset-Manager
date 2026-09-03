// Deterministic normalization of a grammar-constrained generation into a
// canonical Ideogram 4 caption. Fixes everything the grammar cannot express:
// hex color case/format, bbox clamping to 0-1000 and min<=max ordering,
// palette length caps, photo/art variant conflicts, and canonical key order.
// Never invents content — unfixable fields are dropped if optional, and the
// whole result is rejected (ok: false) if a required field is unusable.

import { LIMITS } from "./ideogram-schema.mjs";

function nonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeHexColor(value) {
  if (typeof value !== "string") return null;
  let v = value.trim().toUpperCase();
  if (!v.startsWith("#")) v = "#" + v;
  if (/^#[0-9A-F]{3}$/.test(v)) {
    v = "#" + [...v.slice(1)].map((c) => c + c).join("");
  }
  return /^#[0-9A-F]{6}$/.test(v) ? v : null;
}

function normalizePalette(value, maxItems) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const entry of value) {
    const hex = normalizeHexColor(entry);
    if (hex !== null && !out.includes(hex)) out.push(hex);
    if (out.length >= maxItems) break;
  }
  return out.length > 0 ? out : null;
}

// Accepts the official array form [y_min, x_min, y_max, x_max] or the labeled
// object form {y_min, x_min, y_max, x_max} used by the generation grammar;
// always returns the official array form.
function normalizeBbox(value) {
  let coords = value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    coords = [value.y_min, value.x_min, value.y_max, value.x_max];
  }
  if (!Array.isArray(coords) || coords.length !== 4) return null;
  const nums = coords.map((n) => {
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    return Math.min(LIMITS.bboxMax, Math.max(LIMITS.bboxMin, Math.round(n)));
  });
  if (nums.some((n) => n === null)) return null;
  let [yMin, xMin, yMax, xMax] = nums;
  if (yMin > yMax) [yMin, yMax] = [yMax, yMin];
  if (xMin > xMax) [xMin, xMax] = [xMax, xMin];
  return [yMin, xMin, yMax, xMax];
}

// Key order: photo -> aesthetics, lighting, photo, medium, color_palette
//            art   -> aesthetics, lighting, medium, art_style, color_palette
//
// The generation grammar always emits ALL of aesthetics, lighting, medium,
// photo and art_style (flat object, no branching). The official schema wants
// exactly one variant, so the field matching `medium` is kept and the other
// is dropped. Missing/empty style content is NOT papered over with
// placeholders — { ok: false, reason } is returned so the caller retries
// with the reason fed back to the model. color_palette stays optional:
// a missing/invalid palette is dropped, never a reason to reject.
function normalizeStyle(style) {
  if (typeof style !== "object" || style === null || Array.isArray(style)) {
    return { ok: false, reason: "style_description is missing; include the style_description object with aesthetics, lighting, medium, photo, art_style and color_palette" };
  }
  const aesthetics = nonEmptyString(style.aesthetics);
  if (aesthetics === null) {
    return { ok: false, reason: "style_description.aesthetics is empty; describe the aesthetics with comma-separated keywords" };
  }
  const lighting = nonEmptyString(style.lighting);
  if (lighting === null) {
    return { ok: false, reason: "style_description.lighting is empty; describe the light in the image in detail" };
  }
  const medium = nonEmptyString(style.medium);
  if (medium === null) {
    return { ok: false, reason: "style_description.medium is empty; set it to \"photograph\" for photos or the broad type (e.g. illustration, painting, 3d_render) otherwise" };
  }
  const photo = nonEmptyString(style.photo);
  const artStyle = nonEmptyString(style.art_style);
  const palette = normalizePalette(style.color_palette, LIMITS.stylePaletteMax);

  if (medium.toLowerCase() === "photograph") {
    // Tolerate the model describing the photo through the art field.
    const photoText = photo || artStyle;
    if (photoText === null) {
      return { ok: false, reason: "style_description.photo is empty; describe the camera/lens details (e.g. 35mm, f/1.4, shallow depth of field, eye-level)" };
    }
    const out = { aesthetics, lighting, photo: photoText, medium: "photograph" };
    if (palette !== null) out.color_palette = palette;
    return { ok: true, style: out };
  }

  if (artStyle === null) {
    return { ok: false, reason: `style_description.art_style is empty; describe the ${medium} style in detail (technique, outlines, texture)` };
  }
  const out = { aesthetics, lighting, medium, art_style: artStyle };
  if (palette !== null) out.color_palette = palette;
  return { ok: true, style: out };
}

// Key order: obj  -> type, bbox, desc, color_palette
//            text -> type, bbox, text, desc, color_palette
function normalizeElement(element) {
  if (typeof element !== "object" || element === null || Array.isArray(element)) {
    return null;
  }
  const desc = nonEmptyString(element.desc);
  if (desc === null) return null;
  const bbox = normalizeBbox(element.bbox);
  const palette = normalizePalette(element.color_palette, LIMITS.elementPaletteMax);
  const text = element.type === "text" ? nonEmptyString(element.text) : null;

  const out = { type: text !== null ? "text" : "obj" };
  if (bbox !== null) out.bbox = bbox;
  if (text !== null) out.text = text;
  out.desc = desc;
  if (palette !== null) out.color_palette = palette;
  return out;
}

// Returns { ok: true, value } with a caption in canonical key order, or
// { ok: false, reason } when required content is unusable (caller regenerates).
export function normalizeCaption(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "output is not a JSON object" };
  }

  const composition = raw.compositional_deconstruction;
  if (typeof composition !== "object" || composition === null || Array.isArray(composition)) {
    return { ok: false, reason: "compositional_deconstruction is missing" };
  }
  const highLevel = nonEmptyString(raw.high_level_description);
  const background = nonEmptyString(composition.background) ?? highLevel;
  if (background === null) {
    return { ok: false, reason: "compositional_deconstruction.background is empty" };
  }
  const elements = Array.isArray(composition.elements)
    ? composition.elements.map(normalizeElement).filter((e) => e !== null)
    : [];
  if (elements.length === 0) {
    return { ok: false, reason: "compositional_deconstruction.elements is empty" };
  }

  // Top-level key order: high_level_description, style_description,
  // compositional_deconstruction.
  const styled = normalizeStyle(raw.style_description);
  if (!styled.ok) {
    return { ok: false, reason: styled.reason };
  }
  const style = styled.style;
  const out = {};
  if (highLevel !== null) out.high_level_description = highLevel;
  out.style_description = style;
  out.compositional_deconstruction = { background, elements };
  return { ok: true, value: out };
}

// Compact serialization, matching the official docs' recommendation of
// json.dumps(caption, separators=(",", ":"), ensure_ascii=False).
export function serializeCaption(caption) {
  return JSON.stringify(caption);
}
