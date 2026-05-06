import type { DB } from "../../db/connection.js";
import { createAppSettingsStorage } from "../storage/app-settings.storage.js";

export interface ImageGenerationSize {
  width: number;
  height: number;
}

export interface ImageGenerationUserSettings {
  background: ImageGenerationSize;
  portrait: ImageGenerationSize;
  selfie: ImageGenerationSize;
}

const IMAGE_DIMENSION_MIN = 64;
const IMAGE_DIMENSION_MAX = 4096;

const DEFAULT_IMAGE_GENERATION_SETTINGS: ImageGenerationUserSettings = {
  background: { width: 1024, height: 576 },
  portrait: { width: 512, height: 512 },
  selfie: { width: 512, height: 768 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function clampImageDimension(value: unknown, fallback: number) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(IMAGE_DIMENSION_MIN, Math.min(IMAGE_DIMENSION_MAX, Math.round(numeric)));
}

function readSize(raw: Record<string, unknown>, widthKey: string, heightKey: string, fallback: ImageGenerationSize) {
  return {
    width: clampImageDimension(raw[widthKey], fallback.width),
    height: clampImageDimension(raw[heightKey], fallback.height),
  };
}

export function parseImageGenerationUserSettings(raw: string | null): ImageGenerationUserSettings {
  if (!raw) return DEFAULT_IMAGE_GENERATION_SETTINGS;

  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return DEFAULT_IMAGE_GENERATION_SETTINGS;

    return {
      background: readSize(
        parsed,
        "imageBackgroundWidth",
        "imageBackgroundHeight",
        DEFAULT_IMAGE_GENERATION_SETTINGS.background,
      ),
      portrait: readSize(
        parsed,
        "imagePortraitWidth",
        "imagePortraitHeight",
        DEFAULT_IMAGE_GENERATION_SETTINGS.portrait,
      ),
      selfie: readSize(parsed, "imageSelfieWidth", "imageSelfieHeight", DEFAULT_IMAGE_GENERATION_SETTINGS.selfie),
    };
  } catch {
    return DEFAULT_IMAGE_GENERATION_SETTINGS;
  }
}

export async function loadImageGenerationUserSettings(db: DB): Promise<ImageGenerationUserSettings> {
  const raw = await createAppSettingsStorage(db).get("ui");
  return parseImageGenerationUserSettings(raw);
}
