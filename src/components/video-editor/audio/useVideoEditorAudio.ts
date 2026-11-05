import React, { useCallback, useMemo } from "react";
import type { SourceAudioTrackSettings } from "@/components/video-editor/audio/audioTypes";
import { resolveSourceTrackRoutingPolicy } from "@/lib/exporter/sourceTrackRoutingPolicy";
import type { AudioRegion, ClipRegion, WebcamClip, WebcamOverlaySettings } from "../types";
import { findClipAtTimelineTime } from "../types";
import { isClipMutedById } from "./clipAudio";
import { useAudioPreviewSync } from "./useAudioPreviewSync";
import { useClipAudioSettingsController } from "./useClipAudioSettingsController";
import { useSourceAudioFallback } from "./useSourceAudioFallback";
import { isWebcamOnOutputTimeline } from "../videoPlayback/webcamSync";
import {
	applyWebcamClipSpan,
	getWebcamClipTimelineRegions,
	resolveWebcamClips,
	splitWebcamClip,
} from "../webcamClips";
import { resolveWebcamAudioTrack, useWebcamMediaInfo } from "./useWebcamAudio";

function extractLocalPathFromMediaServerUrl(input: string | null | undefined): string | null {
	if (!input) return null;
	try {
		const url = new URL(input);
		const isLocalMediaServer =
			(url.protocol === "http:" || url.protocol === "https:") &&
			(url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
			url.pathname === "/video";
		if (!isLocalMediaServer) return null;
		return url.searchParams.get("path");
	} catch {
		return null;
	}
}

interface UseVideoEditorAudioParams {
	currentSourcePath: string | null;
	selectedClipId: string | null;
	clipRegions: ClipRegion[];
	audioRegions: AudioRegion[];
	sourceAudioTrackSettingsByClip: Record<string, SourceAudioTrackSettings>;
	setSourceAudioTrackSettingsByClip: React.Dispatch<
		React.SetStateAction<Record<string, SourceAudioTrackSettings>>
	>;
	defaultSourceAudioTrackSettings: SourceAudioTrackSettings;
	setDefaultSourceAudioTrackSettings: React.Dispatch<
		React.SetStateAction<SourceAudioTrackSettings>
	>;
	currentTime: number;
	timelineTime: number;
	duration: number;
	isPlaying: boolean;
	previewVolume: number;
	sourceAudioFallbackRefreshKey?: number;
	summarizeErrorMessage: (message: string) => string;
	onSourceFallbackLoadError: (error: unknown) => void;
	webcam: WebcamOverlaySettings;
	setWebcam: React.Dispatch<React.SetStateAction<WebcamOverlaySettings>>;
}

export function useVideoEditorAudio({
	currentSourcePath,
	selectedClipId,
	clipRegions,
	audioRegions,
	sourceAudioTrackSettingsByClip,
	setSourceAudioTrackSettingsByClip,
	defaultSourceAudioTrackSettings,
	setDefaultSourceAudioTrackSettings,
	currentTime,
	timelineTime,
	duration,
	isPlaying,
	previewVolume,
	sourceAudioFallbackRefreshKey = 0,
	summarizeErrorMessage,
	onSourceFallbackLoadError,
	webcam,
	setWebcam,
}: UseVideoEditorAudioParams) {
	const fallbackLookupSourcePath = useMemo(
		() => extractLocalPathFromMediaServerUrl(currentSourcePath) ?? currentSourcePath,
		[currentSourcePath],
	);

	const { sourceAudioFallbackPaths, sourceAudioFallbackStartDelayMsByPath } =
		useSourceAudioFallback({
			currentSourcePath: fallbackLookupSourcePath,
			refreshKey: sourceAudioFallbackRefreshKey,
			summarizeErrorMessage,
		});

	const sourceTrackRoutingPolicy = useMemo(
		() => resolveSourceTrackRoutingPolicy(currentSourcePath, sourceAudioFallbackPaths),
		[currentSourcePath, sourceAudioFallbackPaths],
	);
	const previewSourceAudioFallbackPaths = sourceTrackRoutingPolicy.playbackPaths;
	const shouldMutePreviewVideo = sourceTrackRoutingPolicy.muteEmbeddedPreview;

	const activeClipIdAtCurrentTime = useMemo(
		() => findClipAtTimelineTime(timelineTime * 1000, clipRegions)?.id ?? null,
		[clipRegions, timelineTime],
	);
	const isCurrentClipMuted = useMemo(
		() =>
			activeClipIdAtCurrentTime === null ||
			isClipMutedById(activeClipIdAtCurrentTime, clipRegions),
		[activeClipIdAtCurrentTime, clipRegions],
	);

	const {
		sourceAudioTrackMeta,
		activeSourceAudioTrackSettings,
		selectedClipSourceAudioTrackSettings,
		getSourceAudioTrackSettingsForClip,
		onSourceAudioTracksMetaChange,
		onSelectedClipSourceAudioTrackVolumeChange,
		onSelectedClipSourceAudioTrackNormalizeChange,
		embeddedSourcePreviewGain,
		getSourceTrackPreviewGain,
	} = useClipAudioSettingsController({
		selectedClipId,
		activeClipId: activeClipIdAtCurrentTime,
		sourceAudioTrackSettingsByClip,
		setSourceAudioTrackSettingsByClip,
		defaultSourceAudioTrackSettings,
		setDefaultSourceAudioTrackSettings,
	});

	const { playSourceAudioPreview } = useAudioPreviewSync({
		audioRegions,
		previewVolume,
		isPlaying,
		currentTime,
		timelineTime,
		duration,
		sourcePlaybackRate: findClipAtTimelineTime(timelineTime * 1000, clipRegions)?.speed ?? 1,
		previewSourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath,
		sourceAudioResourceVersion: sourceAudioFallbackRefreshKey,
		isCurrentClipMuted,
		getSourceTrackPreviewGain,
		onSourceFallbackLoadError,
	});

	const { hasAudio: webcamHasAudio, durationMs: webcamDurationMs } = useWebcamMediaInfo(
		webcam.enabled ? webcam.sourcePath : null,
	);
	const timelineAudioRegions = useMemo(() => {
		if (!webcam.enabled || !webcam.sourcePath || !isWebcamOnOutputTimeline(webcam)) {
			return audioRegions;
		}
		return [
			...audioRegions,
			...getWebcamClipTimelineRegions(
				resolveWebcamClips(webcam, webcamDurationMs),
				webcam.sourcePath,
				webcam.audioVolume ?? 1,
			),
		];
	}, [audioRegions, webcam, webcamDurationMs]);
	const updateWebcamClips = useCallback(
		(update: (clips: WebcamClip[]) => WebcamClip[]) => {
			setWebcam((previous) => ({
				...previous,
				clips: update(resolveWebcamClips(previous, webcamDurationMs)),
			}));
		},
		[setWebcam, webcamDurationMs],
	);
	const changeWebcamClipSpan = useCallback(
		(id: string, span: { start: number; end: number }) => {
			updateWebcamClips((clips) => applyWebcamClipSpan(clips, id, span, webcamDurationMs));
		},
		[updateWebcamClips, webcamDurationMs],
	);
	const deleteWebcamClip = useCallback(
		(id: string) => {
			updateWebcamClips((clips) => clips.filter((clip) => clip.id !== id));
		},
		[updateWebcamClips],
	);
	const splitWebcamClipAt = useCallback(
		(timeMs: number) => {
			updateWebcamClips((clips) => splitWebcamClip(clips, timeMs));
		},
		[updateWebcamClips],
	);
	const webcamAudioTrack = useMemo(
		() => resolveWebcamAudioTrack(webcam, webcamHasAudio),
		[webcam, webcamHasAudio],
	);
	const webcamPreviewVolume =
		webcamAudioTrack && (webcamAudioTrack.timeline === "output" || !isCurrentClipMuted)
			? webcamAudioTrack.gain * previewVolume
			: 0;

	return {
		timelineAudioRegions,
		changeWebcamClipSpan,
		deleteWebcamClip,
		splitWebcamClipAt,
		webcamHasAudio,
		webcamAudioTrack,
		webcamPreviewVolume,
		sourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath,
		previewSourceAudioFallbackPaths,
		shouldMutePreviewVideo,
		activeClipIdAtCurrentTime,
		isCurrentClipMuted,
		sourceAudioTrackMeta,
		activeSourceAudioTrackSettings,
		selectedClipSourceAudioTrackSettings,
		playSourceAudioPreview,
		getSourceAudioTrackSettingsForClip,
		onSourceAudioTracksMetaChange,
		onSelectedClipSourceAudioTrackVolumeChange,
		onSelectedClipSourceAudioTrackNormalizeChange,
		embeddedSourcePreviewGain,
		getSourceTrackPreviewGain,
	};
}
