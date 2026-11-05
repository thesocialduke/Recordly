import { clampMediaTimeToDuration } from "@/lib/mediaTiming";

const HAVE_CURRENT_DATA_READY_STATE = 2;
const WEBCAM_HARD_SEEK_DRIFT_SECONDS = 1;
const WEBCAM_DRIFT_DEADBAND_SECONDS = 0.04;
const WEBCAM_DRIFT_CORRECTION_GAIN = 0.5;
const WEBCAM_MAX_RATE_CORRECTION = 0.12;
const WEBCAM_MAX_SEEK_LEAD_SECONDS = 1.5;

/**
 * Maps the editor timeline time to the corresponding webcam media timestamp,
 * accounting for any recorded webcam start offset and media duration clamps.
 */
export function getWebcamMediaTargetTimeSeconds({
	currentTime,
	webcamDuration,
	timeOffsetMs,
}: {
	currentTime: number;
	webcamDuration?: number | null;
	timeOffsetMs?: number | null;
}): number {
	const safeOffsetMs = Number.isFinite(timeOffsetMs) ? (timeOffsetMs ?? 0) : 0;
	const shiftedTime = currentTime - safeOffsetMs / 1000;
	return clampMediaTimeToDuration(shiftedTime, webcamDuration);
}

export const getWebcamPreviewTargetTimeSeconds = getWebcamMediaTargetTimeSeconds;

export function isWebcamMediaSynchronized({
	currentTime,
	targetTime,
	readyState,
	isSeeking,
	toleranceSeconds = 0.12,
}: {
	currentTime: number;
	targetTime: number;
	readyState: number;
	isSeeking: boolean;
	toleranceSeconds?: number;
}): boolean {
	return (
		readyState >= HAVE_CURRENT_DATA_READY_STATE &&
		!isSeeking &&
		Math.abs(currentTime - targetTime) <= toleranceSeconds
	);
}

/**
 * Decides whether the webcam media element needs a corrective seek for the
 * current preview frame, while avoiding repeated seeks during active media seeks.
 */
export function shouldSeekWebcamMedia({
	desiredTime,
	isPlaying,
	isSeeking,
	previousTimelineTime,
	timelineTime,
	webcamCurrentTime,
}: {
	desiredTime: number;
	isPlaying: boolean;
	isSeeking: boolean;
	previousTimelineTime: number | null;
	timelineTime: number;
	webcamCurrentTime: number;
}): boolean {
	if (isSeeking) {
		return false;
	}

	const drift = Math.abs(webcamCurrentTime - desiredTime);

	// Large footage with sparse keyframes can take longer to seek than the drift
	// that triggered the seek, so small playback drift is left to rate correction.
	if (isPlaying) {
		return drift > WEBCAM_HARD_SEEK_DRIFT_SECONDS;
	}

	const timelineJumped =
		previousTimelineTime === null || Math.abs(timelineTime - previousTimelineTime) > 0.25;

	return timelineJumped || drift > 0.01;
}

/** Nudges the webcam playback rate so small drift closes without a visible seek. */
export function getWebcamDriftCorrectedPlaybackRate({
	baseRate,
	desiredTime,
	webcamCurrentTime,
}: {
	baseRate: number;
	desiredTime: number;
	webcamCurrentTime: number;
}): number {
	const drift = desiredTime - webcamCurrentTime;
	if (Math.abs(drift) < WEBCAM_DRIFT_DEADBAND_SECONDS) {
		return baseRate;
	}

	const correction = Math.max(
		-WEBCAM_MAX_RATE_CORRECTION,
		Math.min(WEBCAM_MAX_RATE_CORRECTION, drift * WEBCAM_DRIFT_CORRECTION_GAIN),
	);
	return baseRate * (1 + correction);
}

/** Aims a corrective seek ahead by the last measured seek cost so it lands in sync. */
export function getWebcamCorrectiveSeekTime({
	desiredTime,
	lastSeekDurationSeconds,
	webcamDuration,
}: {
	desiredTime: number;
	lastSeekDurationSeconds: number;
	webcamDuration?: number | null;
}): number {
	const lead = Math.max(0, Math.min(WEBCAM_MAX_SEEK_LEAD_SECONDS, lastSeekDurationSeconds));
	return clampMediaTimeToDuration(desiredTime + lead, webcamDuration);
}

/**
 * Recorded webcams share the screen recording's clock, so they follow its trims until
 * they are edited. Added or edited footage runs on the edit's timeline instead.
 */
export function isWebcamOnOutputTimeline(
	webcam:
		| { sourcePath?: string | null; visibleRanges?: unknown; clips?: unknown }
		| null
		| undefined,
): boolean {
	if (!webcam?.sourcePath) {
		return false;
	}
	if (webcam.clips) {
		return true;
	}
	if (webcam.visibleRanges) {
		return false;
	}
	const fileName = webcam.sourcePath.split(/[\\/]/).pop() ?? "";
	return !/-webcam\.[^.]+$/i.test(fileName);
}

/** Maps a clock time to the footage frame to show, and whether any footage covers that time. */
export function resolveWebcamMediaTime({
	webcam,
	clockTime,
	webcamDuration,
}: {
	webcam:
		| {
				sourcePath?: string | null;
				visibleRanges?: unknown;
				timeOffsetMs?: number | null;
				clips?: { id: string; startMs: number; endMs: number; sourceStartMs: number }[];
		  }
		| null
		| undefined;
	clockTime: number;
	webcamDuration?: number | null;
}): { mediaTime: number; active: boolean; clipId: string | null } {
	if (webcam?.clips && isWebcamOnOutputTimeline(webcam)) {
		const timeMs = clockTime * 1000;
		const ordered = [...webcam.clips].sort((a, b) => a.startMs - b.startMs);
		const clip = ordered.find(({ startMs, endMs }) => timeMs >= startMs && timeMs < endMs);
		if (clip) {
			return {
				mediaTime: clampMediaTimeToDuration(
					(clip.sourceStartMs + timeMs - clip.startMs) / 1000,
					webcamDuration,
				),
				active: true,
				clipId: clip.id,
			};
		}

		// Holding position between clips keeps the forward-only export decoder from rewinding.
		const previous = ordered.filter(({ endMs }) => endMs <= timeMs).pop();
		const heldMs = previous
			? previous.sourceStartMs + previous.endMs - previous.startMs
			: (ordered[0]?.sourceStartMs ?? 0);
		return {
			mediaTime: clampMediaTimeToDuration(heldMs / 1000, webcamDuration),
			active: false,
			clipId: null,
		};
	}

	return {
		mediaTime: getWebcamMediaTargetTimeSeconds({
			currentTime: clockTime,
			webcamDuration,
			timeOffsetMs: webcam?.timeOffsetMs,
		}),
		active: isWebcamFootageActive({
			currentTime: clockTime,
			webcamDuration,
			timeOffsetMs: webcam?.timeOffsetMs,
		}),
		clipId: null,
	};
}

/** True while the timeline sits inside the footage, after applying its start offset. */
export function isWebcamFootageActive({
	currentTime,
	webcamDuration,
	timeOffsetMs,
}: {
	currentTime: number;
	webcamDuration?: number | null;
	timeOffsetMs?: number | null;
}): boolean {
	const safeOffsetMs = Number.isFinite(timeOffsetMs) ? (timeOffsetMs ?? 0) : 0;
	const mediaTime = currentTime - safeOffsetMs / 1000;
	return mediaTime >= 0 && (webcamDuration == null || mediaTime < webcamDuration);
}

/** Missing ranges means an original recording; an empty list means no webcam frames. */
export function isWebcamVisibleAtSourceTime(webcam: { visibleRanges?: { startMs: number; endMs: number }[] } | undefined, sourceTimeSeconds: number): boolean {
	return !webcam?.visibleRanges || webcam.visibleRanges.some(({ startMs, endMs }) => sourceTimeSeconds * 1000 >= startMs && sourceTimeSeconds * 1000 < endMs);
}
