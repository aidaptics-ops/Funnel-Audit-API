import type { CaptureResult } from "../../pipeline/capture.js";
import type { VideoRecord } from "../../types/index.js";
import type { VideoEntry } from "../landing_types.js";

/**
 * Only canonical, unambiguous id shapes are accepted. A thumbnail URL, a
 * player-config URL or a bare embed host yields null rather than a guess.
 */
const YOUTUBE_ID = /(?:youtube(?:-nocookie)?\.com\/(?:embed|v)\/|youtu\.be\/|[?&]v=)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;
const VIMEO_ID = /vimeo\.com\/(?:video\/)?(\d{6,})(?!\d)/;
const WISTIA_ID = /wistia\.(?:com|net)\/(?:[A-Za-z0-9_-]+\/)*(?:medias|iframe)\/([A-Za-z0-9]{6,})(?![A-Za-z0-9])/;
const LOOM_ID = /loom\.com\/(?:embed|share)\/([A-Za-z0-9]{8,})(?![A-Za-z0-9])/;

export function buildVideos(capture: CaptureResult): VideoEntry[] {
  return dedupeOverlapping(capture.record.videos).map((video, index) => toEntry(video, index));
}

/**
 * One embedded player commonly matches several detector passes: Wistia renders a
 * <video>, an iframe and a wrapper div stacked at the same coordinates, which
 * would otherwise read as three separate videos and break "single dominant
 * video". Records sharing a position and size are the same player, so the most
 * identifiable one wins.
 */
function dedupeOverlapping(videos: VideoRecord[]): VideoRecord[] {
  const kept: VideoRecord[] = [];

  for (const video of videos) {
    const overlapIndex = kept.findIndex((existing) => sharesGeometry(existing, video));
    if (overlapIndex === -1) {
      kept.push(video);
      continue;
    }
    if (score(video) > score(kept[overlapIndex])) kept[overlapIndex] = video;
  }

  return kept;
}

function sharesGeometry(a: VideoRecord, b: VideoRecord): boolean {
  if (a.src && b.src && a.src === b.src) return true;
  const ax = a.width ?? 0;
  const ay = a.height ?? 0;
  const bx = b.width ?? 0;
  const by = b.height ?? 0;
  // Without geometry there is nothing to compare, so treat them as distinct.
  if (!ax || !ay || !bx || !by) return false;
  const near = (left: number, right: number, tolerance: number) => Math.abs(left - right) <= tolerance;
  return (
    near(a.y ?? 0, b.y ?? 0, 24) && near(ax, bx, Math.max(24, ax * 0.1)) && near(ay, by, Math.max(24, ay * 0.1))
  );
}

/** A named provider with a source is more useful than an anonymous wrapper. */
function score(video: VideoRecord): number {
  let value = 0;
  if (video.provider && video.provider !== "unknown") value += 2;
  if (video.src) value += 2;
  if (video.duration != null) value += 1;
  if (video.embedded) value += 1;
  return value;
}

function toEntry(video: VideoRecord, index: number): VideoEntry {
  return {
    index,
    provider: video.provider,
    src: video.src ?? null,
    video_id: parseVideoId(video.provider, video.src),
    embedded: video.embedded,
    visible: video.visible,
    above_fold: video.position === "above_fold",
    position: video.position,
    y: numberOrNull(video.y),
    width: numberOrNull(video.width),
    height: numberOrNull(video.height),
    autoplay: video.autoplay ?? null,
    muted: video.muted ?? null,
    controls: video.controls ?? null,
    duration_seconds: typeof video.duration === "number" ? video.duration : null,
    duration_text: typeof video.duration === "string" ? video.duration : null,
    thumbnail: video.thumbnail ?? null,
    play_button_visible: video.play_button_visible,
    limitation: video.analysis_limitation ?? null,
  };
}

function parseVideoId(provider: string, src: string | null): string | null {
  if (!src) return null;
  switch (provider) {
    case "youtube":
      return YOUTUBE_ID.exec(src)?.[1] ?? null;
    case "vimeo":
      return VIMEO_ID.exec(src)?.[1] ?? null;
    case "wistia":
      return WISTIA_ID.exec(src)?.[1] ?? null;
    case "loom":
      return LOOM_ID.exec(src)?.[1] ?? null;
    default:
      return null;
  }
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
