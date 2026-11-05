import type { AudioRegion, WebcamClip, WebcamOverlaySettings } from "./types";

const WEBCAM_CLIP_ID_PREFIX = "webcam-clip-";
const WEBCAM_CLIP_MIN_DURATION_MS = 100;
/** Sits below every real audio track, which number up from zero. */
export const WEBCAM_TIMELINE_TRACK_INDEX = 1000;

export function isWebcamClipId(id: string | null | undefined): boolean {
	return Boolean(id?.startsWith(WEBCAM_CLIP_ID_PREFIX));
}

/** Untouched footage has no stored clips, so it shows as one clip placed by its start offset. */
export function resolveWebcamClips(
	webcam: Pick<WebcamOverlaySettings, "clips" | "timeOffsetMs">,
	durationMs: number | null,
): WebcamClip[] {
	if (webcam.clips) {
		return webcam.clips;
	}
	if (!durationMs || durationMs <= 0) {
		return [];
	}

	const offsetMs = webcam.timeOffsetMs ?? 0;
	return [
		{
			id: `${WEBCAM_CLIP_ID_PREFIX}1`,
			startMs: Math.max(0, offsetMs),
			endMs: offsetMs + durationMs,
			sourceStartMs: Math.max(0, -offsetMs),
		},
	];
}

/** Moving keeps the footage window, while dragging an edge trims it. */
export function applyWebcamClipSpan(
	clips: WebcamClip[],
	id: string,
	span: { start: number; end: number },
	durationMs: number | null,
): WebcamClip[] {
	return clips.map((clip) => {
		if (clip.id !== id) {
			return clip;
		}

		let startMs = Math.round(span.start);
		let endMs = Math.round(span.end);
		let sourceStartMs = clip.sourceStartMs;
		if (endMs - startMs !== clip.endMs - clip.startMs && startMs !== clip.startMs) {
			sourceStartMs += startMs - clip.startMs;
			if (sourceStartMs < 0) {
				startMs -= sourceStartMs;
				sourceStartMs = 0;
			}
		}
		if (durationMs) {
			endMs = Math.min(endMs, startMs + durationMs - sourceStartMs);
		}
		return {
			...clip,
			startMs,
			endMs: Math.max(endMs, startMs + WEBCAM_CLIP_MIN_DURATION_MS),
			sourceStartMs,
		};
	});
}

export function splitWebcamClip(clips: WebcamClip[], atMs: number): WebcamClip[] {
	const splitMs = Math.round(atMs);
	const target = clips.find(
		(clip) =>
			splitMs >= clip.startMs + WEBCAM_CLIP_MIN_DURATION_MS &&
			splitMs <= clip.endMs - WEBCAM_CLIP_MIN_DURATION_MS,
	);
	if (!target) {
		return clips;
	}

	const nextIndex =
		Math.max(
			0,
			...clips.map((clip) =>
				Number.parseInt(clip.id.slice(WEBCAM_CLIP_ID_PREFIX.length), 10),
			),
		) + 1;
	return clips.flatMap((clip) =>
		clip.id === target.id
			? [
					{ ...clip, endMs: splitMs },
					{
						id: `${WEBCAM_CLIP_ID_PREFIX}${nextIndex}`,
						startMs: splitMs,
						endMs: clip.endMs,
						sourceStartMs: clip.sourceStartMs + splitMs - clip.startMs,
					},
				]
			: [clip],
	);
}

/** Webcam clips ride on the timeline's audio row machinery as their own track. */
export function getWebcamClipTimelineRegions(
	clips: WebcamClip[],
	sourcePath: string,
	volume: number,
): AudioRegion[] {
	return clips.map((clip) => ({
		id: clip.id,
		startMs: clip.startMs,
		endMs: clip.endMs,
		audioPath: sourcePath,
		volume,
		trackIndex: WEBCAM_TIMELINE_TRACK_INDEX,
	}));
}
