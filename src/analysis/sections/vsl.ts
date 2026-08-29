import type { CaptureResult } from "../../pipeline/capture.js";
import type { CtaEntry, VideoEntry, VslSection, VslValue } from "../landing_types.js";
import { detected, unknown } from "../landing_types.js";

/** Copy that instructs the visitor to watch rather than to read. */
const WATCH_LANGUAGE = /(watch|press play|video below|turn (your )?sound on|volume)/i;

const INDICATOR_NAMES = [
  "video_above_fold",
  "single_dominant_video",
  "large_player",
  "autoplay",
  "minimal_navigation",
  "watch_language",
  "cta_below_video",
] as const;

export function buildVsl(
  capture: CaptureResult,
  videos: VideoEntry[],
  ctas: CtaEntry[],
  navItemCount: number,
): VslSection {
  const indicators = {
    video_above_fold: false,
    single_dominant_video: false,
    large_player: false,
    autoplay: false,
    minimal_navigation: false,
    watch_language: false,
    cta_below_video: false,
  };

  if (videos.length === 0) {
    return {
      determination: unknown<VslValue>("No video elements were detected on the page"),
      indicators,
    };
  }

  const candidate = pickCandidate(videos);
  const viewportWidth = capture.snapshot.viewport.width;
  const visibleText = capture.record.visible_text || capture.snapshot.visible_text || "";
  const evidence: string[] = [];

  const aboveFoldVideo = videos.find((video) => video.above_fold) ?? null;
  if (aboveFoldVideo) {
    indicators.video_above_fold = true;
    evidence.push(
      `video_above_fold: ${aboveFoldVideo.provider} player at index ${aboveFoldVideo.index}` +
        `${aboveFoldVideo.y === null ? "" : ` (y=${aboveFoldVideo.y})`} is above the fold`,
    );
  }

  const dominance = describeDominance(candidate, videos);
  if (dominance) {
    indicators.single_dominant_video = true;
    evidence.push(`single_dominant_video: ${dominance}`);
  }

  if (candidate.width !== null && candidate.height !== null) {
    const widthShare = viewportWidth > 0 ? candidate.width / viewportWidth : 0;
    if (candidate.width >= 480 || widthShare >= 0.45) {
      indicators.large_player = true;
      evidence.push(
        `large_player: candidate player measures ${candidate.width}x${candidate.height}px` +
          ` in a ${viewportWidth}px viewport (${Math.round(widthShare * 100)}% of viewport width)`,
      );
    }
  }

  if (candidate.autoplay === true) {
    indicators.autoplay = true;
    evidence.push(
      `autoplay: the candidate ${candidate.provider} player reports autoplay=true` +
        `${candidate.src ? ` (${trim(candidate.src)})` : ""}`,
    );
  }

  if (navItemCount <= 3) {
    indicators.minimal_navigation = true;
    evidence.push(`minimal_navigation: ${navItemCount} navigation item(s) detected`);
  }

  const watchMatch = WATCH_LANGUAGE.exec(visibleText);
  if (watchMatch) {
    indicators.watch_language = true;
    evidence.push(`watch_language: "${snippetAround(visibleText, watchMatch.index)}"`);
  }

  const ctaBelow =
    candidate.y === null
      ? null
      : ctas.find((cta) => cta.visible && cta.position.y > (candidate.y as number)) ?? null;
  if (ctaBelow) {
    indicators.cta_below_video = true;
    evidence.push(
      `cta_below_video: "${trim(ctaBelow.text)}" at y=${ctaBelow.position.y} sits below the` +
        ` candidate video at y=${candidate.y}`,
    );
  }

  const fired = INDICATOR_NAMES.filter((name) => indicators[name]);
  const missing = INDICATOR_NAMES.filter((name) => !indicators[name]);
  const pageType = capture.record.page_type;

  if (pageType === "checkout" || pageType === "login") {
    return {
      determination: unknown<VslValue>(
        `Page is classified as "${pageType}", so its video is not treated as a sales video` +
          ` (${fired.length} VSL indicator(s) present: ${fired.join(", ") || "none"})`,
      ),
      indicators,
    };
  }

  if (fired.length < 3) {
    return {
      determination: unknown<VslValue>(
        `Only ${fired.length} of ${INDICATOR_NAMES.length} VSL indicators were observed` +
          ` (${fired.join(", ") || "none"}); at least 3 are required. Missing: ${missing.join(", ")}`,
      ),
      indicators,
    };
  }

  const confidence = Math.min(0.9, 0.4 + 0.1 * fired.length);
  return {
    determination: detected<VslValue>(
      { video_index: candidate.index, provider: candidate.provider },
      confidence,
      evidence,
    ),
    indicators,
  };
}

function pickCandidate(videos: VideoEntry[]): VideoEntry {
  const aboveFold = videos.find((video) => video.above_fold);
  if (aboveFold) return aboveFold;

  let largest: VideoEntry | null = null;
  let largestArea = 0;
  for (const video of videos) {
    const size = area(video);
    if (size !== null && size > largestArea) {
      largestArea = size;
      largest = video;
    }
  }
  return largest ?? videos[0];
}

/**
 * Dominance can only be claimed when every other player has measurable
 * dimensions; an unmeasured player might well be the larger one.
 */
function describeDominance(candidate: VideoEntry, videos: VideoEntry[]): string | null {
  if (videos.length === 1) return "exactly one video element was detected on the page";

  const candidateArea = area(candidate);
  if (candidateArea === null || candidateArea === 0) return null;

  let largestOther = 0;
  for (const video of videos) {
    if (video.index === candidate.index) continue;
    const size = area(video);
    if (size === null) return null;
    if (candidateArea < size * 2) return null;
    if (size > largestOther) largestOther = size;
  }

  return (
    `candidate player covers ${candidateArea}px^2 (${candidate.width}x${candidate.height}),` +
    ` at least 2x the largest of the ${videos.length - 1} other player(s) at ${largestOther}px^2`
  );
}

function area(video: VideoEntry): number | null {
  if (video.width === null || video.height === null) return null;
  return video.width * video.height;
}

function snippetAround(text: string, index: number): string {
  const start = Math.max(0, index - 50);
  const raw = text.slice(start, start + 200).replace(/\s+/g, " ").trim();
  return trim(raw);
}

function trim(value: string): string {
  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}
