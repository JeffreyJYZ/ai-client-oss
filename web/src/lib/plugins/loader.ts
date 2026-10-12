import { decode } from "@lib/plugins/effect";
import {
	ApiVersionIncompatible,
	ManifestInvalid,
	type PluginError,
	PluginFault,
	PluginLoadFailed,
} from "@lib/plugins/errors";
import type { Disposable, Host } from "@lib/plugins/host";
import { manifestSchema, type PluginManifest } from "@lib/plugins/manifest";
import { judgeApiVersion, judgeEngine } from "@lib/plugins/version";
import { Cause, Duration, Effect, Exit, Scope } from "effect";

/**
 * How long a load's read/import/setup unit may take before it is treated as a
 * failure (spec §3). Generous enough for a real bundle to evaluate, short
 * enough that a plugin which never returns cannot hang the boot.
 */
export const LOAD_TIMEOUT: Duration.Duration = Duration.seconds(10);

/**
 * A plugin module's default export (spec §6). It is `setup` and nothing else:
 * the loader reads identity from the manifest, so a module cannot claim
 * another plugin's id. `void | Disposable` is deliberate (spec §2) — a `setup`
 * may return nothing, or a handle disposed first on unload.
 */
export interface PluginModule {
	// biome-ignore lint/suspicious/noConfusingVoidType: see above
	readonly setup: (host: Host) => void | Disposable;
}

/**
 * Where plugin files are read from (spec §6) — the platform source adapter.
 * Injected, never imported: the desktop and web adapters differ, and the
 * loader only ever reads. `list` exposes the raw manifests (invalid ones
 * verbatim, for the UI to show); `read` returns one file's text.
 */
export interface PluginSource {
	readonly list: () => Effect.Effect<readonly unknown[]>;
	readonly read: (
		id: string,
		relPath: string,
	) => Effect.Effect<string, PluginLoadFailed>;
}

/**
 * Turns an entry file's source text into a module (spec §6). Injected, never
 * imported: the real importer is a browser-only blob import (Task 17), which
 * is why the loader is tested against fakes.
 */
export interface ModuleImporter {
	readonly importSource: (
		source: string,
		name: string,
	) => Effect.Effect<PluginModule, PluginLoadFailed>;
}

/**
 * A loaded, live plugin (spec §3): its manifest, and the `Scope` that owns
 * every registration it made. Closing the scope is unload.
 */
export interface LoadedPlugin {
	readonly manifest: PluginManifest;
	readonly scope: Scope.Closeable;
}

/**
 * What a load is given (spec §6). The source and importer are the injected
 * seams; `hostFor` builds the per-plugin `Host` because the caller owns the
 * registries (Task 3's `makeHost`) while the loader owns the plugin's
 * `Scope`, and only that pairing can bind registrations to the plugin.
 * `timeout` overrides {@link LOAD_TIMEOUT} so a test can pin the bound.
 */
export interface LoadDeps {
	readonly source: PluginSource;
	readonly importer: ModuleImporter;
	readonly hostFor: (pluginId: string, scope: Scope.Scope) => Host;
	readonly timeout?: Duration.Input;
}

const decodeManifest = decode(
	manifestSchema,
	(detail) => new ManifestInvalid({ detail }),
);

/**
 * The version gate (spec §10), the consumer of `host.version`: the plugin API
 * major must match (else refuse) and its minor only warns, and the manifest's
 * `engines.app` bound must be satisfied by the running app version (else
 * refuse). An unparsable version on either axis is a warning, never a refusal.
 */
export const satisfiesApiVersion = (
	host: Host,
	manifest: PluginManifest,
): Effect.Effect<void, ApiVersionIncompatible> =>
	Effect.gen(function* () {
		const api = judgeApiVersion(host.version.api, manifest.apiVersion);
		if (api.verdict === "warn") {
			yield* Effect.logWarning(api.detail);
		}
		if (api.verdict === "refuse") {
			return yield* new ApiVersionIncompatible({
				detail: api.detail,
				pluginId: manifest.id,
			});
		}

		const engine = judgeEngine(manifest.engines.app, host.version.app);
		if (engine.verdict === "warn") {
			yield* Effect.logWarning(engine.detail);
		}
		if (engine.verdict === "refuse") {
			return yield* new ApiVersionIncompatible({
				detail: engine.detail,
				pluginId: manifest.id,
			});
		}
	});

/**
 * Run `setup` and normalise the handle it may return. The author-facing
 * return type is `void | Disposable` (spec §2); here it becomes a plain
 * optional handle so the release step is a single `dispose`. `setup` runs
 * inside `Effect.sync`, so anything it throws is a defect the caller maps to a
 * `PluginFault` rather than a crash.
 */
const acquireHandle = (
	module: PluginModule,
	host: Host,
): Effect.Effect<Disposable | undefined> =>
	Effect.sync(() => module.setup(host) as Disposable | undefined);

/**
 * Dispose the handle a `setup` returned, if any. A throw here is a plugin
 * fault, so it is logged rather than allowed to escape: a buggy
 * `dispose` must not break the unload of everything else (spec §9).
 */
const releaseHandle = (
	pluginId: string,
	handle: Disposable | undefined,
): Effect.Effect<void> =>
	handle === undefined
		? Effect.void
		: Effect.sync(() => handle.dispose()).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning(
						new PluginFault({
							detail: `plugin "${pluginId}" threw while disposing a handle: ${Cause.pretty(cause)}`,
							pluginId,
						}),
					),
				),
			);

/**
 * Map every cause to the subsystem's error vocabulary (spec §9). A typed
 * failure is already a `PluginError` and passes through untouched; an
 * interruption is re-raised untouched so cancellation is never swallowed;
 * anything left is a defect — plugin code that threw — which becomes a
 * `PluginFault`.
 */
const toPluginError = (
	cause: Cause.Cause<PluginError>,
	pluginId: string,
): Effect.Effect<never, PluginError> => {
	if (Cause.hasFails(cause) || Cause.hasInterrupts(cause)) {
		return Effect.failCause(cause);
	}
	return Effect.fail(
		new PluginFault({ detail: Cause.pretty(cause), pluginId }),
	);
};

/**
 * Turn one raw manifest into a live plugin (spec §6): decode the manifest,
 * open the plugin's scope, run the version gate, read the entry, import it and
 * call `setup` — all inside that scope, so closing it removes everything the
 * plugin registered. Every step is wrapped by `Effect.timeout` (a plugin that
 * never finishes is a load failure, not a hung boot) and every failure maps to
 * a tagged error, with the scope closed so a failed load leaves no trace
 * (spec §9). Identity comes from the manifest, never the module.
 *
 * The setup handle is registered with `Effect.acquireRelease` rather than a
 * bare `Scope.addFinalizer`: that closes the window an interrupt could land in
 * between `setup` returning a handle and that handle's finalizer being
 * attached, which is what keeps the subsystem's no-leak property intact.
 */
export const loadPlugin = (
	rawManifest: unknown,
	deps: LoadDeps,
): Effect.Effect<LoadedPlugin, PluginError> =>
	Effect.gen(function* () {
		const manifest = yield* decodeManifest(rawManifest);
		const scope = yield* Scope.make();
		const host = deps.hostFor(manifest.id, scope);
		const timeout = deps.timeout ?? LOAD_TIMEOUT;

		const activate = Effect.gen(function* () {
			yield* satisfiesApiVersion(host, manifest);
			const text = yield* deps.source.read(manifest.id, manifest.entry);
			const module = yield* deps.importer.importSource(text, manifest.entry);
			// `setup` is synchronous, and `acquireRelease` makes an acquire
			// uninterruptible, so the handle it returns is owned by the scope
			// from the moment the call returns — an interrupt can never land
			// between the call and its disposal registration. The read and
			// import above stay interruptible, which is what lets the timeout
			// below fire.
			yield* Effect.acquireRelease(acquireHandle(module, host), (handle) =>
				releaseHandle(manifest.id, handle),
			);
		});

		return yield* Effect.provideService(activate, Scope.Scope, scope).pipe(
			Effect.timeout(timeout),
			Effect.catchTag("TimeoutError", () =>
				Effect.fail(
					new PluginLoadFailed({
						detail: `plugin "${manifest.id}" did not finish loading within ${Duration.toMillis(timeout)}ms`,
						pluginId: manifest.id,
					}),
				),
			),
			Effect.catchCause((cause) => toPluginError(cause, manifest.id)),
			Effect.as({ manifest, scope } satisfies LoadedPlugin),
			// On any failure (including a fault) close the scope, so a failed
			// load leaves no registration behind. On success it stays open —
			// it is the plugin's lifetime, and `unloadPlugin` closes it.
			Effect.onExit((exit) =>
				Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void,
			),
		);
	});

/**
 * Unload a plugin (spec §3): close its scope, disposing its `setup` handle
 * first and then every registration it made, in reverse order. Closing a scope
 * twice is a no-op, so this is idempotent.
 */
export const unloadPlugin = (plugin: LoadedPlugin): Effect.Effect<void> =>
	Scope.close(plugin.scope, Exit.void);
