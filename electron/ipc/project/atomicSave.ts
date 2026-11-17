import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const pendingWrites = new Map<string, Promise<void>>();

const unsupportedDirectorySyncErrors = new Set([
	"EACCES",
	"EINVAL",
	"EISDIR",
	"ENOSYS",
	"ENOTSUP",
	"EOPNOTSUPP",
	"EPERM",
]);

export function getProjectBackupPath(projectPath: string): string {
	return `${projectPath}.bak`;
}

function getQueueKey(projectPath: string): string {
	const resolvedPath = path.resolve(projectPath);
	return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function createTemporaryPath(parentDir: string, label: string): string {
	return path.join(parentDir, `.recordly-${label}-${process.pid}-${randomUUID()}.tmp`);
}

async function getExistingFileMode(filePath: string): Promise<number | undefined> {
	try {
		return (await fs.stat(filePath)).mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

async function writeSyncedTemporaryFile(
	filePath: string,
	contents: string,
	mode?: number,
): Promise<void> {
	const handle = await fs.open(filePath, "wx", mode);
	try {
		await handle.writeFile(contents, "utf-8");
		if (mode !== undefined) {
			await handle.chmod(mode);
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncExistingFile(filePath: string): Promise<void> {
	const handle = await fs.open(filePath, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncParentDirectory(parentDir: string): Promise<void> {
	if (process.platform === "win32") {
		return;
	}

	try {
		const handle = await fs.open(parentDir, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (!code || !unsupportedDirectorySyncErrors.has(code)) {
			throw error;
		}
	}
}

async function preservePreviousGeneration(
	targetPath: string,
	backupPath: string,
	backupTemporaryPath: string,
): Promise<void> {
	try {
		await fs.copyFile(targetPath, backupTemporaryPath, fsConstants.COPYFILE_EXCL);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			await fs.rm(backupPath, { force: true });
			return;
		}
		throw error;
	}

	await syncExistingFile(backupTemporaryPath);
	await fs.rename(backupTemporaryPath, backupPath);
}

export const PROJECT_VERSION_HISTORY_DIR = "Version History";
const PROJECT_FILE_SUFFIX = ".recordly";
const VERSION_INTERVAL_MS = 60_000;
const MAX_VERSIONS_PER_PROJECT = 50;

export function getProjectVersionHistoryDir(projectPath: string): string {
	const resolved = path.resolve(projectPath);
	return path.join(path.dirname(resolved), PROJECT_VERSION_HISTORY_DIR, path.basename(resolved));
}

function countClipRegions(contents: string): number | null {
	try {
		const clips = (JSON.parse(contents) as { editor?: { clipRegions?: unknown } })?.editor
			?.clipRegions;
		return Array.isArray(clips) ? clips.length : null;
	} catch {
		return null;
	}
}

function formatVersionStamp(date: Date): string {
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} at ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * Keeps dated copies of a project before it is overwritten. Autosave runs half a
 * second after every edit and the .bak file only holds one older copy, so a single
 * mistake (like undoing everything) could otherwise replace all saved work. A copy
 * is kept at most once a minute, and always when the new save has fewer clips.
 */
export async function preserveProjectVersion(
	projectPath: string,
	nextContents: string,
	now: Date = new Date(),
): Promise<string | null> {
	let previousContents: string;
	try {
		previousContents = await fs.readFile(projectPath, "utf-8");
	} catch {
		return null;
	}
	if (previousContents === nextContents) return null;

	const historyDir = getProjectVersionHistoryDir(projectPath);
	await fs.mkdir(historyDir, { recursive: true });
	const existing = (await fs.readdir(historyDir))
		.filter((name) => name.endsWith(PROJECT_FILE_SUFFIX))
		.sort();

	const previousClips = countClipRegions(previousContents);
	const nextClips = countClipRegions(nextContents);
	const losesClips = previousClips !== null && nextClips !== null && nextClips < previousClips;
	let recentEnough = false;
	const newest = existing[existing.length - 1];
	if (newest) {
		const stat = await fs.stat(path.join(historyDir, newest));
		recentEnough = now.getTime() - stat.mtimeMs < VERSION_INTERVAL_MS;
	}
	if (recentEnough && !losesClips) return null;

	const versionPath = path.join(historyDir, `${formatVersionStamp(now)}${PROJECT_FILE_SUFFIX}`);
	await fs.writeFile(versionPath, previousContents, "utf-8");
	existing.push(path.basename(versionPath));
	existing.sort();
	for (const stale of existing.slice(0, Math.max(0, existing.length - MAX_VERSIONS_PER_PROJECT))) {
		await fs.rm(path.join(historyDir, stale), { force: true }).catch(() => undefined);
	}
	return versionPath;
}

async function commitProjectFile(projectPath: string, contents: string): Promise<void> {
	const targetPath = path.resolve(projectPath);
	const parentDir = path.dirname(targetPath);
	const backupPath = getProjectBackupPath(targetPath);
	const temporaryPath = createTemporaryPath(parentDir, "project");
	const backupTemporaryPath = createTemporaryPath(parentDir, "backup");
	const existingMode = await getExistingFileMode(targetPath);

	try {
		await preserveProjectVersion(targetPath, contents).catch((error) => {
			console.warn("[project] Could not keep a version history copy:", error);
		});
		await writeSyncedTemporaryFile(temporaryPath, contents, existingMode);
		await preservePreviousGeneration(targetPath, backupPath, backupTemporaryPath);
		await fs.rename(temporaryPath, targetPath);
		await syncParentDirectory(parentDir);
	} finally {
		await Promise.all([
			fs.rm(temporaryPath, { force: true }).catch(() => undefined),
			fs.rm(backupTemporaryPath, { force: true }).catch(() => undefined),
		]);
	}
}

export async function writeProjectFileAtomically(
	projectPath: string,
	contents: string,
): Promise<void> {
	const queueKey = getQueueKey(projectPath);
	const previousWrite = pendingWrites.get(queueKey) ?? Promise.resolve();
	const currentWrite = previousWrite
		.catch(() => undefined)
		.then(() => commitProjectFile(projectPath, contents));
	pendingWrites.set(queueKey, currentWrite);

	try {
		await currentWrite;
	} finally {
		if (pendingWrites.get(queueKey) === currentWrite) {
			pendingWrites.delete(queueKey);
		}
	}
}
