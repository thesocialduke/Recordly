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
	>,
	hasAudio: boolean,
): WebcamAudioTrack | null {
	const gain = Math.max(0, Math.min(1, webcam.audioVolume ?? DEFAULT_WEBCAM_AUDIO_VOLUME));
	if (
		!webcam.enabled ||
		!webcam.sourcePath ||
		!hasAudio ||
		!(webcam.audioEnabled ?? DEFAULT_WEBCAM_AUDIO_ENABLED) ||
		gain <= 0
	) {
		return null;
	}

	return {
		path: webcam.sourcePath,
		offsetMs: webcam.timeOffsetMs ?? 0,
		gain,
		timeline: isWebcamOnOutputTimeline(webcam) ? "output" : "source",
	};
}

/** Recorded webcam files are video-only, so sound is only offered when the file has some. */
export function useWebcamHasAudio(sourcePath: string | null): boolean {
	const [probe, setProbe] = useState<{ path: string; hasAudio: boolean } | null>(null);

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
					});
				}
			} catch (error) {
				console.warn("[useWebcamHasAudio] Could not inspect webcam footage:", error);
				if (!cancelled) {
					setProbe({ path: sourcePath, hasAudio: false });
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [sourcePath]);

	return probe?.path === sourcePath && probe.hasAudio;
}
