import { fixWebmDuration } from "@fix-webm-duration/fix";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useScopedT } from "@/contexts/I18nContext";
import {
	getVideoExtensionForMimeType,
	isWebmMimeType,
	selectWebcamRecordingMimeType,
} from "@/hooks/recordingMimeType";
import { useMicrophoneDevices } from "@/hooks/useMicrophoneDevices";
import { useVideoDevices } from "@/hooks/useVideoDevices";
import {
	getTeleprompterScrollDelta,
	parseTeleprompterSettings,
	TELEPROMPTER_STORAGE_KEY,
} from "../launch/teleprompter";

const COUNTDOWN_SECONDS = 3;
const VIDEO_BITRATE = 12_000_000;
const AUDIO_BITRATE = 192_000;
const MP4_MIME_TYPES = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4"];
const MICROPHONE_WAIT_MS = 10_000;

type Phase = "idle" | "countdown" | "recording" | "saving";
type MicrophoneState = "pending" | "ready" | "unavailable";

function selectMimeType() {
	return (
		MP4_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ??
		selectWebcamRecordingMimeType()
	);
}

function formatElapsed(ms: number) {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function loadTeleprompterSettings() {
	try {
		return parseTeleprompterSettings(localStorage.getItem(TELEPROMPTER_STORAGE_KEY));
	} catch {
		return parseTeleprompterSettings(null);
	}
}

export function WebcamRecorderPanel({
	replacesFootage,
	getPlayheadMs,
	onPlaybackStart,
	onPlaybackStop,
	onRecorded,
	onClose,
}: {
	replacesFootage: boolean;
	getPlayheadMs: () => number;
	onPlaybackStart: () => void;
	onPlaybackStop: () => void;
	onRecorded: (path: string, startMs: number) => void;
	onClose: () => void;
}) {
	const t = useScopedT("settings");
	const camera = useVideoDevices(true);
	const microphone = useMicrophoneDevices(true);
	const [phase, setPhase] = useState<Phase>("idle");
	const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
	const [elapsedMs, setElapsedMs] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [cameraReady, setCameraReady] = useState(false);
	const [microphoneState, setMicrophoneState] = useState<MicrophoneState>("pending");
	const [playAlong, setPlayAlong] = useState(true);
	const [script, setScript] = useState(() => loadTeleprompterSettings().script);
	const [showScript, setShowScript] = useState(false);
	const previewRef = useRef<HTMLVideoElement | null>(null);
	const scriptRef = useRef<HTMLDivElement | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const discardRef = useRef(false);
	const busy = phase !== "idle";

	const cameraId = camera.selectedDeviceId;
	const microphoneId = microphone.selectedDeviceId;
	useEffect(() => {
		let cancelled = false;
		const useId = (id: string) => (id && id !== "default" ? { exact: id } : undefined);
		const stream = new MediaStream();
		streamRef.current = stream;
		setCameraReady(false);
		setMicrophoneState("pending");

		// Camera and microphone open separately so a stuck microphone cannot blank the preview.
		void navigator.mediaDevices
			.getUserMedia({
				video: {
					deviceId: useId(cameraId),
					width: { ideal: 1920 },
					height: { ideal: 1080 },
					frameRate: { ideal: 30 },
				},
			})
			.then((cameraStream) => {
				const [track] = cameraStream.getVideoTracks();
				if (cancelled || !track) {
					for (const unused of cameraStream.getTracks()) unused.stop();
					return;
				}
				stream.addTrack(track);
				setError(null);
				setCameraReady(true);
				if (previewRef.current) previewRef.current.srcObject = stream;
			})
			.catch((cause) => {
				console.error("Could not open the camera:", cause);
				if (!cancelled) {
					setError(
						t(
							"effects.webcamRecorderCameraError",
							"Could not open the camera. Check Camera in System Settings, Privacy & Security.",
						),
					);
				}
			});

		const microphoneTimer = window.setTimeout(() => {
			if (!cancelled && stream.getAudioTracks().length === 0) {
				setMicrophoneState("unavailable");
			}
		}, MICROPHONE_WAIT_MS);
		void (async () => {
			try {
				const access = await window.electronAPI.requestMicrophoneAccess();
				if (!access.granted) throw new Error("Microphone access denied");
				const microphoneStream = await navigator.mediaDevices.getUserMedia({
					audio: { deviceId: useId(microphoneId) },
				});
				const [track] = microphoneStream.getAudioTracks();
				if (cancelled || !track) {
					for (const unused of microphoneStream.getTracks()) unused.stop();
					return;
				}
				stream.addTrack(track);
				setMicrophoneState("ready");
			} catch (cause) {
				console.warn("Could not open the microphone:", cause);
				if (!cancelled) setMicrophoneState("unavailable");
			}
		})();

		return () => {
			cancelled = true;
			window.clearTimeout(microphoneTimer);
			for (const track of stream.getTracks()) track.stop();
			if (streamRef.current === stream) streamRef.current = null;
		};
	}, [cameraId, microphoneId, t]);

	useEffect(
		() => () => {
			discardRef.current = true;
			if (recorderRef.current?.state === "recording") recorderRef.current.stop();
		},
		[],
	);

	const beginRecording = useCallback(() => {
		const stream = streamRef.current;
		if (!stream) return;

		const mimeType = selectMimeType();
		const chunks: Blob[] = [];
		const startMs = Math.round(getPlayheadMs());
		const startedAt = performance.now();
		const recorder = new MediaRecorder(stream, {
			videoBitsPerSecond: VIDEO_BITRATE,
			audioBitsPerSecond: AUDIO_BITRATE,
			...(mimeType ? { mimeType } : {}),
		});
		recorderRef.current = recorder;
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) chunks.push(event.data);
		};
		recorder.onstop = async () => {
			recorderRef.current = null;
			if (discardRef.current) return;

			try {
				const type = recorder.mimeType || mimeType;
				const blob = new Blob(chunks, type ? { type } : undefined);
				const finalBlob = isWebmMimeType(type)
					? await fixWebmDuration(blob, performance.now() - startedAt)
					: blob;
				const result = await window.electronAPI.storeRecordedVideo(
					await finalBlob.arrayBuffer(),
					`recording-${Date.now()}-camera${getVideoExtensionForMimeType(type)}`,
				);
				if (!result.success || !result.path) {
					throw new Error(result.message ?? "Could not save the recording");
				}
				onRecorded(result.path, startMs);
			} catch (cause) {
				console.error("Could not save the webcam recording:", cause);
				setError(t("effects.webcamRecorderSaveError", "Could not save the recording."));
				setPhase("idle");
			}
		};
		recorder.start(1000);
		if (playAlong) onPlaybackStart();
		setElapsedMs(0);
		setPhase("recording");
	}, [getPlayheadMs, onPlaybackStart, onRecorded, playAlong, t]);

	useEffect(() => {
		if (phase !== "countdown") return;
		if (countdown <= 0) {
			beginRecording();
			return;
		}
		const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
		return () => window.clearTimeout(timer);
	}, [beginRecording, countdown, phase]);

	useEffect(() => {
		if (phase !== "recording") return;
		const startedAt = performance.now();
		const speed = loadTeleprompterSettings().speed;
		let frame = 0;
		let last = startedAt;
		let carry = 0;
		const step = (now: number) => {
			setElapsedMs(now - startedAt);
			carry += getTeleprompterScrollDelta(speed, now - last);
			last = now;
			const whole = Math.floor(carry);
			if (whole > 0 && scriptRef.current) {
				scriptRef.current.scrollTop += whole;
				carry -= whole;
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [phase]);

	const updateScript = (value: string) => {
		setScript(value);
		try {
			localStorage.setItem(
				TELEPROMPTER_STORAGE_KEY,
				JSON.stringify({ ...loadTeleprompterSettings(), script: value }),
			);
		} catch {
			// The script still works for this take when it cannot be saved.
		}
	};

	const stopRecording = () => {
		setPhase("saving");
		onPlaybackStop();
		recorderRef.current?.stop();
	};

	const selectClass =
		"h-9 w-full min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 text-xs text-white disabled:opacity-50";

	return (
		<div
			role="dialog"
			aria-label={t("effects.recordWebcam")}
			className="fixed left-1/2 top-3 z-[60] flex max-h-[calc(100vh-24px)] w-[380px] -translate-x-1/2 flex-col gap-3 overflow-y-auto rounded-2xl border border-white/10 bg-[#16171a] p-3 text-white shadow-2xl"
		>
			{showScript &&
				(busy ? (
					<div
						ref={scriptRef}
						className="h-28 overflow-hidden whitespace-pre-wrap rounded-lg bg-black/40 p-2 text-lg leading-snug"
					>
						{script}
					</div>
				) : (
					<textarea
						aria-label={t("effects.webcamRecorderScript", "Script")}
						value={script}
						onChange={(event) => updateScript(event.target.value)}
						placeholder={t("effects.webcamRecorderScriptHint", "Paste your script here")}
						className="h-28 resize-none rounded-lg border border-white/10 bg-black/40 p-2 text-sm text-white"
					/>
				))}
			<div className="relative aspect-video overflow-hidden rounded-xl bg-black">
				<video
					ref={previewRef}
					autoPlay
					muted
					playsInline
					className="h-full w-full -scale-x-100 object-cover"
				/>
				{phase === "countdown" && (
					<div className="absolute inset-0 flex items-center justify-center bg-black/40 text-6xl font-semibold">
						{countdown}
					</div>
				)}
				{phase === "recording" && (
					<div className="absolute left-2 top-2 rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium tabular-nums">
						{formatElapsed(elapsedMs)}
					</div>
				)}
			</div>
			{error && (
				<p role="alert" className="text-xs leading-4 text-red-400">
					{error}
				</p>
			)}
			<div className="grid grid-cols-2 gap-2">
				<select
					aria-label={t("effects.webcamRecorderCamera", "Camera")}
					value={cameraId}
					disabled={busy}
					onChange={(event) => camera.setSelectedDeviceId(event.target.value)}
					className={selectClass}
				>
					{camera.devices.map((device) => (
						<option key={device.deviceId} value={device.deviceId}>
							{device.label || t("effects.webcamRecorderCamera", "Camera")}
						</option>
					))}
				</select>
				<select
					aria-label={t("effects.webcamRecorderMicrophone", "Microphone")}
					value={microphoneId}
					disabled={busy}
					onChange={(event) => microphone.setSelectedDeviceId(event.target.value)}
					className={selectClass}
				>
					{microphone.devices.map((device) => (
						<option key={device.deviceId} value={device.deviceId}>
							{device.label || t("effects.webcamRecorderMicrophone", "Microphone")}
						</option>
					))}
				</select>
			</div>
			<div className="flex items-center justify-between text-xs text-white/70">
				<span>{t("effects.webcamRecorderPlayAlong", "Play timeline while recording")}</span>
				<Switch
					aria-label={t("effects.webcamRecorderPlayAlong", "Play timeline while recording")}
					checked={playAlong}
					disabled={busy}
					onCheckedChange={setPlayAlong}
				/>
			</div>
			<div className="flex items-center justify-between text-xs text-white/70">
				<span>{t("effects.webcamRecorderShowScript", "Show script")}</span>
				<Switch
					aria-label={t("effects.webcamRecorderShowScript", "Show script")}
					checked={showScript}
					onCheckedChange={setShowScript}
				/>
			</div>
			{microphoneState === "unavailable" && (
				<p role="status" className="text-xs leading-4 text-amber-400">
					{t(
						"effects.webcamRecorderNoMicrophone",
						"Microphone unavailable, so this take will have no sound. Check Microphone in System Settings, Privacy & Security.",
					)}
				</p>
			)}
			{replacesFootage && (
				<p className="text-xs leading-4 text-white/50">
					{t(
						"effects.webcamRecorderReplaces",
						"This take replaces the current webcam footage.",
					)}
				</p>
			)}
			<div className="grid grid-cols-2 gap-2">
				<Button type="button" variant="outline" disabled={busy} onClick={onClose}>
					{t("effects.webcamRecorderClose", "Close")}
				</Button>
				{phase === "recording" ? (
					<Button type="button" onClick={stopRecording}>
						{t("effects.webcamRecorderStop", "Stop")}
					</Button>
				) : (
					<Button
						type="button"
						disabled={busy || !cameraReady || microphoneState === "pending"}
						onClick={() => {
							setCountdown(COUNTDOWN_SECONDS);
							setPhase("countdown");
						}}
					>
						{phase === "saving"
							? t("effects.webcamRecorderSaving", "Saving...")
							: !cameraReady || microphoneState === "pending"
								? t("effects.webcamRecorderOpening", "Opening...")
								: t("effects.webcamRecorderStart", "Start recording")}
					</Button>
				)}
			</div>
		</div>
	);
}
