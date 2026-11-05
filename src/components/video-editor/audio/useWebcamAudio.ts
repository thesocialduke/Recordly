import { useEffect, useState } from "react";
import type { WebcamAudioTrack } from "@/lib/exporter/audioProcessorShared";
import { isWebcamOnOutputTimeline } from "../videoPlayback/webcamSync";
import {
	DEFAULT_WEBCAM_AUDIO_ENABLED,
	DEFAULT_WEBCAM_AUDIO_VOLUME,
	type WebcamOverlaySettings,
} from "../types";

export function resolveWebcamAudioTrack(
	webcam: Pick<
		WebcamOverlaySettings,
		| "enabled"
		| "sourcePath"
		| "timeOffsetMs"
		| "audioEnabled"
		| "audioVolume"
		| "visibleRanges"
		| "clips"
	>,
	hasAudio: boolean,
): WebcamAudioTrack | null {
	const gain = Math.max(0, Math.min(1, webcam.audioVolume ?? DEFAULT_WEBCAM_AUDIO_VOLUME));
	if (
		!webcam.enabled ||
		!webcam.sourcePath ||
		!hasAudio ||
		!(webcam.audioEnabled ?? DEFAULT_WEBCAM_AUDIO_ENABLED) ||
		gain <= 0 ||
		webcam.clips?.length === 0
	) {
		return null;
	}

	return {
		path: webcam.sourcePath,
		offsetMs: webcam.timeOffsetMs ?? 0,
		gain,
		timeline: isWebcamOnOutputTimeline(webcam) ? "output" : "source",
		...(webcam.clips ? { clips: webcam.clips } : {}),
	};
}

/** Recorded webcam files are video-only, so sound is only offered when the file has some. */
export function useWebcamMediaInfo(sourcePath: string | null) {
	const [probe, setProbe] = useState<{
		path: string;
		hasAudio: boolean;
		durationMs: number | null;
	} | null>(null);

	useEffect(() => {
		if (!sourcePath) {
			return;
		}

		let cancelled = false;
		void (async () => {
			try {
				const result = await window.electronAPI?.probeNativeVideoMetadata?.(sourcePath);
				if (!cancelled) {
					setProbe({
						path: sourcePath,
						hasAudio: Boolean(result?.success && result.metadata?.hasAudio),
						durationMs: result?.metadata?.duration
							? Math.round(result.metadata.duration * 1000)
							: null,
					});
				}
			} catch (error) {
				console.warn("[useWebcamMediaInfo] Could not inspect webcam footage:", error);
				if (!cancelled) {
					setProbe({ path: sourcePath, hasAudio: false, durationMs: null });
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [sourcePath]);

	return probe?.path === sourcePath
		? { hasAudio: probe.hasAudio, durationMs: probe.durationMs }
		: { hasAudio: false, durationMs: null };
}
