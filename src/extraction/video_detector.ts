import type { DomSnapshot, VideoRecord } from "../types/index.js";
import { isCalendarEmbedSrc, isFormEmbedSrc } from "./embed_hosts.js";

export function detectVideos(snapshot: DomSnapshot): VideoRecord[] {
  const seen = new Set<string>();
  const videos: VideoRecord[] = [];

  for (const video of snapshot.videos) {
    if (isFormEmbedSrc(video.src) || isCalendarEmbedSrc(video.src)) continue;
    const key = `${video.provider}|${video.src || ""}|${video.position}`;
    if (seen.has(key)) continue;
    seen.add(key);
    videos.push(video);
  }

  return videos;
}
