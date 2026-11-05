import { describe, expect, it } from "vitest";
import { resolveWebcamAudioTrack } from "./useWebcamAudio";

const webcam = {
	enabled: true,
	sourcePath: "/Users/test/Best returns.mp4",
	timeOffsetMs: 1500,
};

describe("resolveWebcamAudioTrack", () => {
	it("includes added footage sound by default, carrying its start offset", () => {
		expect(resolveWebcamAudioTrack(webcam, true)).toEqual({
			path: webcam.sourcePath,
			offsetMs: 1500,
			gain: 1,
			timeline: "output",
		});
	});

	it("skips silent footage so recorded webcam exports keep their fast audio path", () => {
		expect(resolveWebcamAudioTrack(webcam, false)).toBeNull();
	});

	it("respects hidden webcams, the audio switch, and zero volume", () => {
		expect(resolveWebcamAudioTrack({ ...webcam, enabled: false }, true)).toBeNull();
		expect(resolveWebcamAudioTrack({ ...webcam, audioEnabled: false }, true)).toBeNull();
		expect(resolveWebcamAudioTrack({ ...webcam, audioVolume: 0 }, true)).toBeNull();
	});

	it("keeps a recorded webcam's sound on the recording's clock", () => {
		expect(
			resolveWebcamAudioTrack(
				{ ...webcam, sourcePath: "/Users/test/recording-123-webcam.mp4" },
				true,
			)?.timeline,
		).toBe("source");
	});

	it("clamps volume to the range the preview element can play", () => {
		expect(resolveWebcamAudioTrack({ ...webcam, audioVolume: 4 }, true)?.gain).toBe(1);
	});
});
