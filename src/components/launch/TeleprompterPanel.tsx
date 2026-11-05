import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import {
	ArrowCounterClockwise,
	DotsThreeVerticalIcon,
	PauseIcon,
	PlayIcon,
	TextT,
	XIcon,
} from "@/components/ui/icons";
import { useScopedT } from "../../contexts/I18nContext";
import { useAudioLevelMeter } from "../../hooks/useAudioLevelMeter";
import { Button } from "../ui/button";
import { useHudInteraction } from "./contexts/HudInteractionContext";
import styles from "./LaunchWindow.module.css";
import {
	getTeleprompterScrollDelta,
	INITIAL_VOICE_SCROLL_STATE,
	nextVoiceScrollState,
	parseTeleprompterSettings,
	TELEPROMPTER_FONT_SIZE_RANGE,
	TELEPROMPTER_SPEED_RANGE,
	TELEPROMPTER_STORAGE_KEY,
	TELEPROMPTER_VOICE_SENSITIVITIES,
	type TeleprompterSettings,
} from "./teleprompter";

export function useTeleprompterSettings() {
	const [settings, setSettings] = useState(() => {
		try {
			return parseTeleprompterSettings(localStorage.getItem(TELEPROMPTER_STORAGE_KEY));
		} catch {
			return parseTeleprompterSettings(null);
		}
	});
	const update = useCallback((patch: Partial<TeleprompterSettings>) => {
		setSettings((current) => {
			const next = { ...current, ...patch };
			try {
				localStorage.setItem(TELEPROMPTER_STORAGE_KEY, JSON.stringify(next));
			} catch {
				// Keep the teleprompter usable when preferences cannot be saved.
			}
			return next;
		});
	}, []);
	return [settings, update] as const;
}

export function TeleprompterPanel({
	settings,
	onChange,
	recording,
	paused,
	microphoneEnabled,
	microphoneDeviceId,
}: {
	settings: TeleprompterSettings;
	onChange: (patch: Partial<TeleprompterSettings>) => void;
	recording: boolean;
	paused: boolean;
	microphoneEnabled: boolean;
	microphoneDeviceId?: string;
}) {
	const t = useScopedT("launch");
	const { onMouseEnter, onMouseLeave } = useHudInteraction();
	const [editing, setEditing] = useState(() => settings.script.trim() === "");
	const [playing, setPlaying] = useState(false);
	const [offset, setOffset] = useState({ x: 0, y: 0 });
	const scrollRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{
		pointerId: number;
		startX: number;
		startY: number;
		origin: { x: number; y: number };
	} | null>(null);
	const hasScript = settings.script.trim() !== "";

	// Meter runs only while a take is rolling with voice mode on. A denied mic falls back to fixed speed.
	const voiceMeterOn = settings.voiceActivated && recording && !paused && microphoneEnabled;
	const { level: micLevel, error: micError } = useAudioLevelMeter({
		enabled: voiceMeterOn,
		deviceId: microphoneDeviceId,
	});
	const voiceGating = voiceMeterOn && !micError;
	const micLevelRef = useRef(micLevel);
	useEffect(() => {
		micLevelRef.current = micLevel;
	}, [micLevel]);

	// Start from the top and roll with the take; pausing the recording pauses the script.
	useEffect(() => {
		if (!recording || !hasScript) return;
		setEditing(false);
		scrollRef.current?.scrollTo({ top: 0 });
	}, [recording, hasScript]);
	useEffect(() => {
		if (recording && hasScript) setPlaying(!paused);
		else if (!recording) setPlaying(false);
	}, [recording, paused, hasScript]);

	useEffect(() => {
		if (!playing || editing) return;
		let frame = 0;
		let last = performance.now();
		let carry = 0;
		let voice = INITIAL_VOICE_SCROLL_STATE;
		const step = (now: number) => {
			const el = scrollRef.current;
			if (!el) return;
			const elapsedMs = now - last;
			last = now;
			if (voiceGating) {
				voice = nextVoiceScrollState(
					voice,
					micLevelRef.current,
					now,
					settings.voiceSensitivity,
				);
			}
			// Frames without speech advance `last` but add no distance, so resuming doesn't jump.
			if (!voiceGating || voice.speaking) {
				carry += getTeleprompterScrollDelta(settings.speed, elapsedMs);
			}
			const whole = Math.floor(carry);
			if (whole > 0) {
				el.scrollTop += whole;
				carry -= whole;
			}
			if (el.scrollTop >= el.scrollHeight - el.clientHeight - 1) {
				setPlaying(false);
				return;
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [playing, editing, settings.speed, voiceGating, settings.voiceSensitivity]);

	useEffect(() => () => window.electronAPI?.hudOverlaySetKeyboardFocus?.(false), []);
	useEffect(() => {
		if (!editing) window.electronAPI?.hudOverlaySetKeyboardFocus?.(false);
	}, [editing]);

	const handleDragDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
		event.preventDefault();
		window.electronAPI?.hudOverlaySetIgnoreMouse?.(false);
		dragRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			origin: offset,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const handleDragMove = (event: PointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		setOffset({
			x: drag.origin.x + event.clientX - drag.startX,
			y: Math.max(-16, drag.origin.y + event.clientY - drag.startY),
		});
	};
	const handleDragUp = (event: PointerEvent<HTMLDivElement>) => {
		if (dragRef.current?.pointerId !== event.pointerId) return;
		dragRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	const playLabel = playing ? t("teleprompter.pause", "Pause") : t("teleprompter.play", "Play");

	return (
		<div
			className={`${styles.teleprompter} ${styles.electronNoDrag} launch-theme pointer-events-auto`}
			data-hud-interactive
			style={{ transform: `translate(calc(-50% + ${offset.x}px), ${offset.y}px)` }}
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
		>
			<div
				className={styles.teleprompterHeader}
				onPointerDown={handleDragDown}
				onPointerMove={handleDragMove}
				onPointerUp={handleDragUp}
				onPointerCancel={handleDragUp}
			>
				<DotsThreeVerticalIcon weight="fill" size={16} className="text-[#6b6b78]" />
				<span className={styles.teleprompterTitle}>
					{t("teleprompter.title", "Teleprompter")}
				</span>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setEditing((value) => !value)}
					disabled={!hasScript}
				>
					{editing ? t("teleprompter.done", "Done") : t("teleprompter.edit", "Edit")}
				</Button>
				<Button
					variant="ghost"
					size="icon"
					title={playLabel}
					aria-label={playLabel}
					disabled={!hasScript}
					onClick={() => {
						setEditing(false);
						setPlaying((value) => !value);
					}}
				>
					{playing ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
				</Button>
				<Button
					variant="ghost"
					size="icon"
					title={t("teleprompter.restart", "Back to start")}
					aria-label={t("teleprompter.restart", "Back to start")}
					disabled={!hasScript}
					onClick={() => scrollRef.current?.scrollTo({ top: 0 })}
				>
					<ArrowCounterClockwise className="size-4" />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					title={t("teleprompter.close", "Turn off teleprompter")}
					aria-label={t("teleprompter.close", "Turn off teleprompter")}
					onClick={() => onChange({ enabled: false })}
				>
					<XIcon className="size-4" />
				</Button>
			</div>

			{editing ? (
				<textarea
					className={styles.teleprompterEditor}
					value={settings.script}
					placeholder={t(
						"teleprompter.placeholder",
						"Paste or type your script here. Only you can see it — it is hidden from the recording.",
					)}
					onChange={(event) => onChange({ script: event.target.value })}
					// Clicking a non-key HUD window may not fire DOM focus, so request keys on press too.
					onPointerDown={() => window.electronAPI?.hudOverlaySetKeyboardFocus?.(true)}
					onFocus={() => window.electronAPI?.hudOverlaySetKeyboardFocus?.(true)}
					onBlur={() => window.electronAPI?.hudOverlaySetKeyboardFocus?.(false)}
				/>
			) : (
				<div className={styles.teleprompterViewport}>
					<div ref={scrollRef} className={styles.teleprompterScroll}>
						<div className={styles.teleprompterSpacerTop} />
						<p
							className={styles.teleprompterText}
							style={{
								fontSize: settings.fontSize,
								transform: settings.mirrored ? "scaleX(-1)" : undefined,
							}}
						>
							{settings.script}
						</p>
						<div className={styles.teleprompterSpacerBottom} />
					</div>
					<div className={styles.teleprompterGuide} aria-hidden />
				</div>
			)}

			<div className={styles.teleprompterControls}>
				<label className={styles.teleprompterControl}>
					<span>{t("teleprompter.slow", "Slow")}</span>
					<input
						type="range"
						aria-label={t("teleprompter.speed", "Scroll speed")}
						min={TELEPROMPTER_SPEED_RANGE.min}
						max={TELEPROMPTER_SPEED_RANGE.max}
						step={0.5}
						value={settings.speed}
						onChange={(event) => onChange({ speed: Number(event.target.value) })}
					/>
					<span>{t("teleprompter.fast", "Fast")}</span>
				</label>
				<label className={styles.teleprompterControl}>
					<TextT className="size-4" />
					<input
						type="range"
						aria-label={t("teleprompter.fontSize", "Text size")}
						min={TELEPROMPTER_FONT_SIZE_RANGE.min}
						max={TELEPROMPTER_FONT_SIZE_RANGE.max}
						value={settings.fontSize}
						onChange={(event) => onChange({ fontSize: Number(event.target.value) })}
					/>
				</label>
				<label className={styles.teleprompterControl}>
					<input
						type="checkbox"
						checked={settings.mirrored}
						onChange={(event) => onChange({ mirrored: event.target.checked })}
					/>
					<span>{t("teleprompter.mirror", "Mirror")}</span>
				</label>
				<label className={styles.teleprompterControl}>
					<input
						type="checkbox"
						checked={settings.voiceActivated}
						onChange={(event) => onChange({ voiceActivated: event.target.checked })}
					/>
					<span>{t("teleprompter.voice", "Follow my voice")}</span>
				</label>
				{settings.voiceActivated && (
					<label className={styles.teleprompterControl}>
						<span>{t("teleprompter.voiceSensitivity", "Sensitivity")}</span>
						<input
							type="range"
							aria-label={t("teleprompter.voiceSensitivity", "Sensitivity")}
							min={0}
							max={TELEPROMPTER_VOICE_SENSITIVITIES.length - 1}
							step={1}
							value={TELEPROMPTER_VOICE_SENSITIVITIES.indexOf(
								settings.voiceSensitivity,
							)}
							onChange={(event) =>
								onChange({
									voiceSensitivity:
										TELEPROMPTER_VOICE_SENSITIVITIES[
											Number(event.target.value)
										],
								})
							}
						/>
					</label>
				)}
			</div>
		</div>
	);
}
