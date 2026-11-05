import { describe, expect, it } from "vitest";
import {
	getWebcamMediaTargetTimeSeconds,
	getWebcamPreviewTargetTimeSeconds,
	isWebcamMediaSynchronized,
	isWebcamVisibleAtSourceTime,
	getWebcamCorrectiveSeekTime,
	getWebcamDriftCorrectedPlaybackRate,
	isWebcamFootageActive,
	isWebcamOnOutputTimeline,
	shouldSeekWebcamMedia,
} from "./webcamSync";

describe("getWebcamPreviewTargetTimeSeconds", () => {
	it("subtracts positive webcam offsets when the webcam started after the main capture", () => {
		expect(
			getWebcamPreviewTargetTimeSeconds({
				currentTime: 10,
				webcamDuration: 20,
				timeOffsetMs: 250,
			}),
		).toBe(9.75);
	});

	it("adds negative webcam offsets when the webcam started before the main capture", () => {
		expect(
			getWebcamPreviewTargetTimeSeconds({
				currentTime: 0.1,
				webcamDuration: 20,
				timeOffsetMs: -250,
			}),
		).toBe(0.35);
	});

	it("falls back to the unshifted time when the offset is invalid", () => {
		expect(
			getWebcamPreviewTargetTimeSeconds({
				currentTime: 3.5,
				webcamDuration: 20,
				timeOffsetMs: Number.NaN,
			}),
		).toBe(3.5);
	});

	it("clamps to the webcam duration", () => {
		expect(
			getWebcamPreviewTargetTimeSeconds({
				currentTime: 8.9,
				webcamDuration: 9,
				timeOffsetMs: -500,
			}),
		).toBe(9);
	});
});

describe("getWebcamMediaTargetTimeSeconds", () => {
	it("clamps positive offsets at zero when the main timeline is earlier than the webcam start", () => {
		expect(
			getWebcamMediaTargetTimeSeconds({
				currentTime: 0.1,
				webcamDuration: 20,
				timeOffsetMs: 250,
			}),
		).toBe(0);
	});
});

describe("shouldSeekWebcamMedia", () => {
	it("does not issue another corrective seek while the webcam element is already seeking", () => {
		expect(
			shouldSeekWebcamMedia({
				desiredTime: 10.5,
				isPlaying: true,
				isSeeking: true,
				previousTimelineTime: 10,
				timelineTime: 10.5,
				webcamCurrentTime: 9.8,
			}),
		).toBe(false);
	});

	it("seeks when playback drift grows beyond the active threshold", () => {
		expect(
			shouldSeekWebcamMedia({
				desiredTime: 10.5,
				isPlaying: true,
				isSeeking: false,
				previousTimelineTime: 10,
				timelineTime: 10.5,
				webcamCurrentTime: 9.2,
			}),
		).toBe(true);
	});

	it("leaves small playback drift to rate correction instead of seeking", () => {
		expect(
			shouldSeekWebcamMedia({
				desiredTime: 10.5,
				isPlaying: true,
				isSeeking: false,
				previousTimelineTime: 10,
				timelineTime: 10.5,
				webcamCurrentTime: 9.8,
			}),
		).toBe(false);
	});

	it("does not treat a slow UI tick during playback as a timeline jump", () => {
		expect(
			shouldSeekWebcamMedia({
				desiredTime: 10.6,
				isPlaying: true,
				isSeeking: false,
				previousTimelineTime: 10,
				timelineTime: 10.6,
				webcamCurrentTime: 10.55,
			}),
		).toBe(false);
	});

	it("does not seek when the clamped media target is already correct", () => {
		expect(
			shouldSeekWebcamMedia({
				desiredTime: 1 / 60,
				isPlaying: false,
				isSeeking: false,
				previousTimelineTime: 0,
				timelineTime: 0,
				webcamCurrentTime: 1 / 60,
			}),
		).toBe(false);
	});
});

describe("isWebcamMediaSynchronized", () => {
	it("waits for current frame data and a completed seek", () => {
		expect(
			isWebcamMediaSynchronized({
				currentTime: 10,
				targetTime: 10,
				readyState: 1,
				isSeeking: false,
			}),
		).toBe(false);
		expect(
			isWebcamMediaSynchronized({
				currentTime: 10,
				targetTime: 10,
				readyState: 2,
				isSeeking: true,
			}),
		).toBe(false);
	});

	it("accepts a loaded webcam only when it is anchored to the timeline", () => {
		expect(
			isWebcamMediaSynchronized({
				currentTime: 9.95,
				targetTime: 10,
				readyState: 2,
				isSeeking: false,
			}),
		).toBe(true);
		expect(
			isWebcamMediaSynchronized({
				currentTime: 9.5,
				targetTime: 10,
				readyState: 2,
				isSeeking: false,
			}),
		).toBe(false);
	});
});


describe("imported webcam visibility", () => {
	it("hides screen-only spans and uses source-time boundaries", () => {
		const webcam = { visibleRanges: [{ startMs: 1200, endMs: 2000 }, { startMs: 4000, endMs: 5000 }] };
		expect(isWebcamVisibleAtSourceTime(webcam, 1)).toBe(false);
		expect(isWebcamVisibleAtSourceTime(webcam, 1.2)).toBe(true);
		expect(isWebcamVisibleAtSourceTime(webcam, 2)).toBe(false);
		expect(isWebcamVisibleAtSourceTime(webcam, 4.5)).toBe(true);
		expect(isWebcamVisibleAtSourceTime({ visibleRanges: [] }, 0)).toBe(false);
		expect(isWebcamVisibleAtSourceTime({}, 0)).toBe(true);
	});
});

describe("getWebcamDriftCorrectedPlaybackRate", () => {
	it("keeps the base rate inside the deadband", () => {
		expect(
			getWebcamDriftCorrectedPlaybackRate({
				baseRate: 1,
				desiredTime: 10.02,
				webcamCurrentTime: 10,
			}),
		).toBe(1);
	});

	it("speeds up when behind and slows down when ahead, within limits", () => {
		const behind = getWebcamDriftCorrectedPlaybackRate({
			baseRate: 1,
			desiredTime: 10.1,
			webcamCurrentTime: 10,
		});
		const ahead = getWebcamDriftCorrectedPlaybackRate({
			baseRate: 1,
			desiredTime: 10,
			webcamCurrentTime: 10.1,
		});
		expect(behind).toBeCloseTo(1.05);
		expect(ahead).toBeCloseTo(0.95);
		expect(
			getWebcamDriftCorrectedPlaybackRate({
				baseRate: 2,
				desiredTime: 20,
				webcamCurrentTime: 10,
			}),
		).toBeCloseTo(2.24);
	});
});

describe("getWebcamCorrectiveSeekTime", () => {
	it("aims ahead by the measured seek cost, capped and clamped to the media", () => {
		expect(
			getWebcamCorrectiveSeekTime({ desiredTime: 10, lastSeekDurationSeconds: 0.5 }),
		).toBeCloseTo(10.5);
		expect(
			getWebcamCorrectiveSeekTime({ desiredTime: 10, lastSeekDurationSeconds: 9 }),
		).toBeCloseTo(11.5);
		expect(
			getWebcamCorrectiveSeekTime({
				desiredTime: 10,
				lastSeekDurationSeconds: 0.5,
				webcamDuration: 10.2,
			}),
		).toBeLessThanOrEqual(10.2);
	});
});

describe("isWebcamOnOutputTimeline", () => {
	it("treats hand-added footage as independent of the recording's clock", () => {
		expect(isWebcamOnOutputTimeline({ sourcePath: "/Users/test/New project.mp4" })).toBe(true);
	});

	it("keeps recorded webcams and imported sequences on the recording's clock", () => {
		expect(isWebcamOnOutputTimeline({ sourcePath: "/tmp/recording-123-webcam.webm" })).toBe(
			false,
		);
		expect(
			isWebcamOnOutputTimeline({ sourcePath: "/tmp/sequence.mp4", visibleRanges: [] }),
		).toBe(false);
		expect(isWebcamOnOutputTimeline({ sourcePath: null })).toBe(false);
	});
});

describe("isWebcamFootageActive", () => {
	it("is inactive before a positive offset and after the footage ends", () => {
		expect(isWebcamFootageActive({ currentTime: 1, timeOffsetMs: 2000 })).toBe(false);
		expect(isWebcamFootageActive({ currentTime: 2, timeOffsetMs: 2000 })).toBe(true);
		expect(isWebcamFootageActive({ currentTime: 30, webcamDuration: 30 })).toBe(false);
		expect(isWebcamFootageActive({ currentTime: 29.9, webcamDuration: 30 })).toBe(true);
	});

	it("treats a negative offset as starting partway into the footage", () => {
		expect(
			isWebcamFootageActive({ currentTime: 0, webcamDuration: 41.8, timeOffsetMs: -5000 }),
		).toBe(true);
		expect(
			isWebcamFootageActive({ currentTime: 37, webcamDuration: 41.8, timeOffsetMs: -5000 }),
		).toBe(false);
	});
});
